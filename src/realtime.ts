/**
 * Minimal client for Overleaf's realtime service (socket.io 0.9 over xhr-polling).
 * Used for things the HTTP endpoints don't cover: the project's file tree with entity IDs,
 * and operations on a document such as adding comment ranges.
 */

export interface RequestFn {
  (path: string, init?: RequestInit): Promise<Response>;
}

export interface Entity {
  id: string;
  type: "doc" | "file" | "folder";
  path: string;
}

interface Folder {
  _id: string;
  name: string;
  docs?: Array<{ _id: string; name: string }>;
  fileRefs?: Array<{ _id: string; name: string }>;
  folders?: Folder[];
}

/** socket.io 0.9 polling responses frame multiple messages as �<len>�<msg>. */
export function splitSocketFrames(body: string): string[] {
  if (!body.startsWith("�")) return body ? [body] : [];
  const out: string[] = [];
  let i = 0;
  while (i < body.length && body[i] === "�") {
    const end = body.indexOf("�", i + 1);
    const len = Number(body.slice(i + 1, end));
    out.push(body.slice(end + 1, end + 1 + len));
    i = end + 1 + len;
  }
  return out;
}

/** Flatten a project's folder tree into path → entity. Paths have no leading slash; folders end without one. */
export function flattenTree(root: Folder): Map<string, Entity> {
  const out = new Map<string, Entity>();
  const walk = (folder: Folder, prefix: string) => {
    for (const d of folder.docs ?? []) out.set(prefix + d.name, { id: d._id, type: "doc", path: prefix + d.name });
    for (const f of folder.fileRefs ?? []) out.set(prefix + f.name, { id: f._id, type: "file", path: prefix + f.name });
    for (const sub of folder.folders ?? []) {
      out.set(prefix + sub.name, { id: sub._id, type: "folder", path: prefix + sub.name });
      walk(sub, `${prefix}${sub.name}/`);
    }
  };
  walk(root, "");
  return out;
}

/** Overleaf sends doc lines UTF-8 encoded into latin1 strings when encodeRanges is set. */
function decodeLine(line: string): string {
  try {
    return decodeURIComponent(escape(line));
  } catch {
    return line;
  }
}

export class RealtimeSession {
  private inbox: string[] = [];
  private nextAck = 1;
  private closed = false;

  private constructor(
    private readonly request: RequestFn,
    private readonly pollUrl: string,
    readonly rootFolderId: string,
    readonly entities: Map<string, Entity>,
  ) {}

  static async connect(request: RequestFn, projectId: string): Promise<RealtimeSession> {
    const hs = await request(`/socket.io/1/?projectId=${projectId}&t=${Date.now()}`);
    const sid = (await hs.text()).split(":")[0];
    if (!hs.ok || !sid) throw new Error(`Could not connect to Overleaf's realtime service (HTTP ${hs.status}).`);
    const pollUrl = `/socket.io/1/xhr-polling/${sid}?projectId=${projectId}`;

    const pending: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await request(`${pollUrl}&t=${Date.now()}`);
      if (!res.ok) throw new Error(`Realtime poll failed: HTTP ${res.status}`);
      for (const msg of splitSocketFrames(await res.text())) {
        if (msg.startsWith("0:")) throw new Error("Overleaf's realtime service closed the connection.");
        const event = parseEvent(msg);
        if (event?.name === "joinProjectResponse") {
          const root = event.args[0]?.project?.rootFolder?.[0] as Folder | undefined;
          if (!root) throw new Error("joinProject response did not include the project's file tree.");
          const session = new RealtimeSession(request, pollUrl, root._id, flattenTree(root));
          session.inbox.push(...pending);
          return session;
        }
        if (event?.name === "connectionRejected") {
          throw new Error(`Overleaf rejected the realtime connection: ${JSON.stringify(event.args[0])}`);
        }
        pending.push(msg);
      }
    }
    await request(pollUrl, { method: "POST", body: "0::" }).catch(() => {});
    throw new Error("Timed out waiting for Overleaf's project data.");
  }

  private async send(frame: string): Promise<void> {
    const res = await this.request(`${this.pollUrl}&t=${Date.now()}`, { method: "POST", body: frame });
    if (!res.ok) throw new Error(`Realtime send failed: HTTP ${res.status}`);
  }

  private async poll(): Promise<void> {
    const res = await this.request(`${this.pollUrl}&t=${Date.now()}`);
    if (!res.ok) throw new Error(`Realtime poll failed: HTTP ${res.status}`);
    for (const msg of splitSocketFrames(await res.text())) {
      if (msg.startsWith("2:")) await this.send("2::"); // heartbeat
      else if (msg.startsWith("0:")) throw new Error("Overleaf's realtime service closed the connection.");
      else this.inbox.push(msg);
    }
  }

  /** Emit an event and wait for its acknowledgement; returns the ack's arguments. */
  async emit(name: string, args: unknown[], timeoutMs = 20_000): Promise<unknown[]> {
    const id = this.nextAck++;
    await this.send(`5:${id}+::${JSON.stringify({ name, args })}`);
    // Acks look like "6:::<id>+[args...]", or just "6:::<id>" when the callback had no arguments.
    const bare = `6:::${id}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const i = this.inbox.findIndex((m) => m === bare || m.startsWith(`${bare}+`));
      if (i >= 0) {
        const [msg] = this.inbox.splice(i, 1);
        return msg === bare ? [] : (JSON.parse(msg.slice(bare.length + 1)) as unknown[]);
      }
      await this.poll();
    }
    throw new Error(`Timed out waiting for Overleaf to acknowledge ${name}.`);
  }

  async joinDoc(docId: string): Promise<{ text: string; version: number }> {
    const [err, lines, version] = (await this.emit("joinDoc", [docId, { encodeRanges: true }])) as [
      unknown,
      string[],
      number,
    ];
    if (err) throw new Error(`Could not open the document: ${JSON.stringify(err)}`);
    return { text: lines.map(decodeLine).join("\n"), version };
  }

  async applyOps(docId: string, version: number, op: unknown[]): Promise<void> {
    const [err] = await this.emit("applyOtUpdate", [docId, { doc: docId, op, v: version }]);
    if (err) throw new Error(`Overleaf rejected the change: ${JSON.stringify(err)}`);
  }

  async leaveDoc(docId: string): Promise<void> {
    await this.emit("leaveDoc", [docId]).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.send("0::").catch(() => {});
  }
}

function parseEvent(msg: string): { name: string; args: any[] } | undefined {
  if (!msg.startsWith("5:")) return undefined;
  try {
    return JSON.parse(msg.slice(msg.indexOf("{")));
  } catch {
    return undefined;
  }
}
