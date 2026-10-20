import type { Config } from "./config.js";
import { RealtimeSession, type Entity } from "./realtime.js";

export type { Entity };

const USER_AGENT = "mcp-overleaf (+https://github.com/kimhyunji24/mcp-overleaf)";

export interface ProjectSummary {
  id: string;
  name: string;
  lastUpdated?: string;
  accessLevel?: string;
  archived?: boolean;
  trashed?: boolean;
}

export interface OutputFile {
  path: string;
  url: string;
  type?: string;
  build?: string;
}

export interface CompileResult {
  status: string;
  outputFiles: OutputFile[];
  clsiServerId?: string;
  compileGroup?: string;
  pdfDownloadDomain?: string;
}

export interface ThreadMessage {
  id: string;
  content: string;
  timestamp: number | string;
  user_id?: string;
  user?: { first_name?: string; last_name?: string; email?: string };
}

export interface Thread {
  messages?: ThreadMessage[];
  resolved?: boolean;
  resolved_at?: string;
}

export interface DocRanges {
  id: string;
  ranges?: {
    comments?: Array<{ id: string; op: { c: string; p: number; t: string } }>;
  };
}

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}


function metaContent(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`<meta\\s+name="${name}"[^>]*?\\scontent="([^"]*)"`));
  return m ? decodeHtml(m[1]) : undefined;
}

/**
 * Client for Overleaf's (unofficial) web endpoints, authenticated with a browser session cookie.
 * Used for things the Git bridge cannot do: listing projects, compiling, and comments.
 * Opt-in only (OVERLEAF_ENABLE_WEB): these are not publicly supported interfaces.
 */
export class OverleafWeb {
  private readonly cookies = new Map<string, string>();
  private csrfToken?: string;
  private readonly rootFolders = new Map<string, string>();

  constructor(private readonly cfg: Config) {
    if (!cfg.webOptIn) return;
    for (const part of cfg.sessionCookie?.split(";") ?? []) {
      const i = part.indexOf("=");
      if (i > 0) this.cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }

  get enabled(): boolean {
    return this.cookies.size > 0;
  }

  requireEnabled(feature: string): void {
    if (this.enabled) return;
    if (!this.cfg.webOptIn) {
      throw new Error(
        `${feature} needs web mode, which is off by default. Web mode uses Overleaf's internal web endpoints, ` +
          `which may violate Overleaf's Acceptable Use Policy and could get your account suspended. ` +
          `To use it at your own risk, set OVERLEAF_ENABLE_WEB=1 and OVERLEAF_SESSION_COOKIE. See the README.`,
      );
    }
    throw new Error(`${feature} needs OVERLEAF_SESSION_COOKIE (your Overleaf browser session cookie). See the README.`);
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(res: Response): void {
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(urlOrPath: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
    const url = new URL(urlOrPath, this.cfg.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    // Never leak the session cookie to other hosts (e.g. the PDF download domain).
    if (url.host === new URL(this.cfg.baseUrl).host) headers.set("Cookie", this.cookieHeader());

    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.host === new URL(this.cfg.baseUrl).host) this.storeCookies(res);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (/\/login\b/.test(location)) {
        throw new Error(
          "Overleaf session cookie is invalid or expired. Copy a fresh OVERLEAF_SESSION_COOKIE from your browser.",
        );
      }
      if (redirects >= 5 || !location) throw new Error(`Too many redirects fetching ${url.pathname}`);
      return this.request(new URL(location, url).toString(), init, redirects + 1);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    const res = await this.request(path, { ...init, headers });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async getCsrf(refresh = false): Promise<string> {
    if (this.csrfToken && !refresh) return this.csrfToken;
    const html = await (await this.request("/project")).text();
    const token = metaContent(html, "ol-csrfToken");
    if (!token) throw new Error("Could not find a CSRF token on the Overleaf dashboard. Is the session cookie valid?");
    this.csrfToken = token;
    return token;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    this.requireEnabled("Listing projects");
    const res = await this.request("/user/projects", { headers: { Accept: "application/json" } });
    if (res.ok && res.headers.get("content-type")?.includes("json")) {
      const data = (await res.json()) as { projects?: Array<{ _id?: string; id?: string; name: string; accessLevel?: string }> };
      if (data.projects) {
        return data.projects.map((p) => ({ id: p._id ?? p.id ?? "", name: p.name, accessLevel: p.accessLevel }));
      }
    }

    // Fallback: the dashboard page embeds the project list as JSON.
    const html = await (await this.request("/project")).text();
    this.csrfToken ??= metaContent(html, "ol-csrfToken");
    const blob = metaContent(html, "ol-prefetchedProjectsBlob");
    if (!blob) throw new Error("Could not read the project list from Overleaf.");
    const data = JSON.parse(blob) as { projects: Array<ProjectSummary & { _id?: string }> };
    return data.projects.map((p) => ({
      id: p.id ?? p._id ?? "",
      name: p.name,
      lastUpdated: p.lastUpdated,
      accessLevel: p.accessLevel,
      archived: p.archived,
      trashed: p.trashed,
    }));
  }

  async downloadZip(projectId: string): Promise<Uint8Array> {
    this.requireEnabled("Downloading a project without Git");
    const res = await this.request(`/project/${projectId}/download/zip`);
    if (!res.ok) throw new Error(`Downloading project ${projectId} failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async compile(projectId: string, opts: { draft?: boolean } = {}): Promise<CompileResult> {
    this.requireEnabled("Compiling");
    const body = JSON.stringify({
      rootDoc_id: null,
      draft: !!opts.draft,
      check: "silent",
      incrementalCompilesEnabled: true,
      stopOnFirstError: false,
    });
    for (const refresh of [false, true]) {
      const res = await this.request(`/project/${projectId}/compile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Csrf-Token": await this.getCsrf(refresh),
        },
        body,
      });
      if (res.status === 403 && !refresh) continue; // stale CSRF token; retry once with a fresh one
      if (!res.ok) throw new Error(`Compile request failed: HTTP ${res.status}`);
      const data = (await res.json()) as CompileResult;
      data.outputFiles ??= [];
      return data;
    }
    throw new Error("Compile request was rejected (HTTP 403).");
  }

  async fetchOutputFile(result: CompileResult, file: OutputFile): Promise<Response> {
    const params = new URLSearchParams();
    if (result.compileGroup) params.set("compileGroup", result.compileGroup);
    if (result.clsiServerId) params.set("clsiserverid", result.clsiServerId);
    const rel = file.url + (file.url.includes("?") ? "&" : "?") + params.toString();

    let lastError = "";
    for (const base of [result.pdfDownloadDomain, this.cfg.baseUrl]) {
      if (!base) continue;
      try {
        const res = await this.request(base.replace(/\/+$/, "") + rel);
        if (res.ok) return res;
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    throw new Error(`Could not fetch ${file.path}: ${lastError}`);
  }

  /** Open a realtime session, run `fn`, and always disconnect afterwards. */
  async withRealtime<T>(projectId: string, fn: (rt: RealtimeSession) => Promise<T>): Promise<T> {
    this.requireEnabled("This operation");
    const rt = await RealtimeSession.connect((p, init) => this.request(p, init), projectId);
    this.rootFolders.set(projectId, rt.rootFolderId);
    try {
      return await fn(rt);
    } finally {
      await rt.close();
    }
  }

  async getRootFolderId(projectId: string): Promise<string> {
    return this.rootFolders.get(projectId) ?? this.withRealtime(projectId, async (rt) => rt.rootFolderId);
  }

  /** Project file tree with entity IDs, keyed by path. */
  async getEntities(projectId: string): Promise<Map<string, Entity>> {
    return this.withRealtime(projectId, async (rt) => rt.entities);
  }

  /** JSON request with CSRF token, retried once with a fresh token on 403. */
  private async send<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    for (const refresh of [false, true]) {
      const res = await this.request(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Csrf-Token": await this.getCsrf(refresh),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 403 && !refresh) continue;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${method} ${path} failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw new Error(`${method} ${path} was rejected (HTTP 403).`);
  }

  async deleteEntity(projectId: string, entity: Entity): Promise<void> {
    await this.send("DELETE", `/project/${projectId}/${entity.type}/${entity.id}`);
  }

  async renameEntity(projectId: string, entity: Entity, name: string): Promise<void> {
    await this.send("POST", `/project/${projectId}/${entity.type}/${entity.id}/rename`, { name });
  }

  async moveEntity(projectId: string, entity: Entity, folderId: string): Promise<void> {
    await this.send("POST", `/project/${projectId}/${entity.type}/${entity.id}/move`, { folder_id: folderId });
  }

  async createFolder(projectId: string, parentFolderId: string, name: string): Promise<string> {
    const folder = await this.send<{ _id: string }>("POST", `/project/${projectId}/folder`, {
      name,
      parent_folder_id: parentFolderId,
    });
    return folder._id;
  }

  async postThreadMessage(projectId: string, threadId: string, content: string): Promise<void> {
    await this.send("POST", `/project/${projectId}/thread/${threadId}/messages`, { content });
  }

  async setThreadResolved(projectId: string, docId: string, threadId: string, resolved: boolean): Promise<void> {
    await this.send("POST", `/project/${projectId}/doc/${docId}/thread/${threadId}/${resolved ? "resolve" : "reopen"}`, {});
  }

  /**
   * Create or replace a file through the editor's upload endpoint (works on free plans).
   * Intermediate folders in `relPath` are created by Overleaf as needed.
   */
  async uploadFile(projectId: string, relPath: string, data: Uint8Array): Promise<void> {
    this.requireEnabled("Saving without Git");
    const folderId = await this.getRootFolderId(projectId);
    const name = relPath.split("/").pop()!;
    for (const refresh of [false, true]) {
      const form = new FormData();
      form.append("name", name);
      if (relPath.includes("/")) form.append("relativePath", relPath);
      form.append("qqfile", new Blob([new Uint8Array(data)]), name);
      const res = await this.request(`/project/${projectId}/upload?folder_id=${folderId}`, {
        method: "POST",
        headers: { Accept: "application/json", "X-Csrf-Token": await this.getCsrf(refresh) },
        body: form,
      });
      if (res.status === 403 && !refresh) continue;
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || body.success === false) {
        throw new Error(`Uploading ${relPath} failed: ${body.error ?? `HTTP ${res.status}`}`);
      }
      return;
    }
    throw new Error(`Uploading ${relPath} was rejected (HTTP 403).`);
  }

  async getThreads(projectId: string): Promise<Record<string, Thread>> {
    this.requireEnabled("Reading comments");
    return this.json(`/project/${projectId}/threads`);
  }

  async getRanges(projectId: string): Promise<DocRanges[]> {
    this.requireEnabled("Reading comments");
    return this.json(`/project/${projectId}/ranges`);
  }
}
