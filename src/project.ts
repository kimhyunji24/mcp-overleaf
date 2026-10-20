import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type { Config } from "./config.js";
import type { GitClient } from "./git.js";
import type { OverleafWeb } from "./web.js";

const ID_RE = /^[0-9a-f]{24}$/i;
/** How long a local copy is trusted before re-syncing with Overleaf on read. */
const READ_TTL_MS = 15_000;

export interface Checkout {
  dir: string;
  /** "git": read/write working copy. "snapshot": read-only copy from the zip download. */
  mode: "git" | "snapshot";
}

/** Resolve a project-relative path inside `root`, rejecting anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error(`Invalid path: ${rel}`);
  const full = path.resolve(root, cleaned);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes the project: ${rel}`);
  if (relative.split(path.sep)[0] === ".git") throw new Error(`Path not allowed: ${rel}`);
  return full;
}

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export class ProjectStore {
  private readonly lastSync = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: Config,
    private readonly web: OverleafWeb,
    private readonly git: GitClient,
  ) {}

  /** Accepts a project ID, an Overleaf project URL, or (with a session cookie) a project name. */
  async resolve(ref?: string): Promise<string> {
    const r = ref?.trim() || this.cfg.defaultProject;
    if (!r) throw new Error("No project given. Pass `project` (ID, URL or name) or set OVERLEAF_PROJECT_ID.");
    const fromUrl = r.match(/project\/([0-9a-f]{24})/i);
    if (fromUrl) return fromUrl[1].toLowerCase();
    if (ID_RE.test(r)) return r.toLowerCase();

    if (!this.web.enabled) {
      throw new Error(`"${r}" is not a project ID. Looking projects up by name requires OVERLEAF_SESSION_COOKIE.`);
    }
    const projects = (await this.web.listProjects()).filter((p) => !p.trashed);
    const needle = r.toLowerCase();
    const exact = projects.filter((p) => p.name.toLowerCase() === needle);
    if (exact.length === 1) return exact[0].id;
    const partial = exact.length ? exact : projects.filter((p) => p.name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0].id;
    if (!partial.length) throw new Error(`No project named "${r}". Use list_projects to see available projects.`);
    throw new Error(
      `"${r}" matches several projects; pass the ID instead:\n` + partial.map((p) => `- ${p.name} (${p.id})`).join("\n"),
    );
  }

  /** Serialize operations per project so concurrent tool calls don't trample the working copy. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    return next;
  }

  private async open(id: string, write: boolean): Promise<Checkout> {
    let gitError: Error | undefined;
    if (this.git.enabled) {
      try {
        return { dir: await this.syncGit(id, write), mode: "git" };
      } catch (e) {
        if (write || !this.web.enabled) throw e;
        gitError = e as Error;
      }
    }
    if (write) {
      throw new Error("Editing files requires OVERLEAF_GIT_TOKEN (Overleaf Git integration). The session cookie only allows reading.");
    }
    if (this.web.enabled) {
      try {
        return { dir: await this.syncSnapshot(id), mode: "snapshot" };
      } catch (e) {
        if (gitError) throw new Error(`${gitError.message}\nZip download fallback also failed: ${(e as Error).message}`);
        throw e;
      }
    }
    throw new Error("No credentials configured. Set OVERLEAF_GIT_TOKEN and/or OVERLEAF_SESSION_COOKIE.");
  }

  private async syncGit(id: string, force: boolean): Promise<string> {
    const dir = path.join(this.cfg.cacheDir, "git", id);
    const key = `git:${id}`;
    if (!existsSync(path.join(dir, ".git"))) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await this.git.clone(id, dir);
    } else if (force || Date.now() - (this.lastSync.get(key) ?? 0) > READ_TTL_MS) {
      await this.git.pull(dir);
    }
    this.lastSync.set(key, Date.now());
    return dir;
  }

  private async syncSnapshot(id: string): Promise<string> {
    const dir = path.join(this.cfg.cacheDir, "snapshots", id);
    const key = `zip:${id}`;
    if (existsSync(dir) && Date.now() - (this.lastSync.get(key) ?? 0) <= READ_TTL_MS) return dir;

    const entries = unzipSync(await this.web.downloadZip(id));
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith("/")) continue;
      const target = safeJoin(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
    this.lastSync.set(key, Date.now());
    return dir;
  }

  read<T>(id: string, fn: (co: Checkout) => Promise<T>): Promise<T> {
    return this.withLock(id, async () => fn(await this.open(id, false)));
  }

  write<T>(id: string, fn: (co: Checkout) => Promise<T>): Promise<T> {
    return this.withLock(id, async () => fn(await this.open(id, true)));
  }
}

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}

export async function readText(root: string, rel: string): Promise<string> {
  const full = safeJoin(root, rel);
  let buf: Buffer;
  try {
    buf = await fs.readFile(full);
  } catch {
    throw new Error(`File not found: ${rel}`);
  }
  if (isBinary(buf)) throw new Error(`${rel} is a binary file and cannot be read as text.`);
  return buf.toString("utf8");
}

/** Read every text file in the project (used for outline parsing and comment lookup). */
export async function readAllText(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const rel of await listFiles(root)) {
    if (!/\.(tex|ltx|sty|cls|bib|bbl|txt|md|cfg|def)$/i.test(rel)) continue;
    const buf = await fs.readFile(safeJoin(root, rel));
    if (!isBinary(buf)) files.set(rel, buf.toString("utf8"));
  }
  return files;
}
