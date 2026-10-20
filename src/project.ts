import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { GitClient } from "./git.js";

const ID_RE = /^[0-9a-f]{24}$/i;
/** How long a local copy is trusted before re-syncing with Overleaf on read. */
const READ_TTL_MS = 15_000;

export interface Checkout {
  dir: string;
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
    private readonly git: GitClient,
  ) {}

  /** Accepts a project ID or an Overleaf project URL. */
  async resolve(ref?: string): Promise<string> {
    const r = ref?.trim() || this.cfg.defaultProject;
    if (!r) throw new Error("No project given. Pass `project` (ID or URL) or set OVERLEAF_PROJECT_ID.");
    const fromUrl = r.match(/project\/([0-9a-f]{24})/i);
    if (fromUrl) return fromUrl[1].toLowerCase();
    if (ID_RE.test(r)) return r.toLowerCase();
    throw new Error(`"${r}" is not an Overleaf project ID or URL.`);
  }

  /** Serialize operations per project so concurrent tool calls don't trample the working copy. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(id, next);
    return next;
  }

  private async open(id: string, write: boolean): Promise<Checkout> {
    if (!this.git.enabled) throw new Error("OVERLEAF_GIT_TOKEN is not set. Generate one in Overleaf → Account Settings → Git Integration.");
    return { dir: await this.syncGit(id, write) };
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
