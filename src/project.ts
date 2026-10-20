import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type { Config } from "./config.js";
import type { GitClient } from "./git.js";
import type { OverleafWeb } from "./web.js";
import { t } from "./i18n.js";

const ID_RE = /^[0-9a-f]{24}$/i;
/** How long a local copy is trusted before re-syncing with Overleaf on read. */
const READ_TTL_MS = 15_000;

export interface Checkout {
  dir: string;
  /** "git": Git working copy. "snapshot": copy from the zip download; changes are saved by web upload. */
  mode: "git" | "snapshot";
}

/** Resolve a project-relative path inside `root`, rejecting anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error(t.invalidPath(rel));
  const full = path.resolve(root, cleaned);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(t.pathEscapes(rel));
  if (relative.split(path.sep)[0] === ".git") throw new Error(t.pathNotAllowed(rel));
  return full;
}

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export class ProjectStore {
  private readonly lastSync = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly noGitAccess = new Set<string>();

  constructor(
    private readonly cfg: Config,
    private readonly web: OverleafWeb,
    private readonly git: GitClient,
  ) {}

  /** Accepts a project ID, an Overleaf project URL, or (with a session cookie) a project name. */
  async resolve(ref?: string): Promise<string> {
    const r = ref?.trim() || this.cfg.defaultProject;
    if (!r) throw new Error(t.noProject());
    const fromUrl = r.match(/project\/([0-9a-f]{24})/i);
    if (fromUrl) return fromUrl[1].toLowerCase();
    if (ID_RE.test(r)) return r.toLowerCase();

    if (!this.web.enabled) {
      throw new Error(t.nameNeedsWeb(r));
    }
    const projects = (await this.web.listProjects()).filter((p) => !p.trashed);
    const needle = r.toLowerCase();
    const exact = projects.filter((p) => p.name.toLowerCase() === needle);
    if (exact.length === 1) return exact[0].id;
    const partial = exact.length ? exact : projects.filter((p) => p.name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0].id;
    if (!partial.length) throw new Error(t.noProjectNamed(r));
    throw new Error(t.ambiguousProject(r, partial.map((p) => `- ${p.name} (${p.id})`).join("\n")));
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
    if (this.git.enabled && !this.noGitAccess.has(id)) {
      try {
        return { dir: await this.syncGit(id, write), mode: "git" };
      } catch (e) {
        if (!this.web.enabled) throw e;
        gitError = e as Error;
        // Git is a paid feature: remember projects without it and go straight to the web path next time.
        if (/no git access|Repository not found|paid plan/i.test(gitError.message)) this.noGitAccess.add(id);
      }
    }
    if (this.web.enabled) {
      try {
        // Always start a write from Overleaf's latest content.
        return { dir: await this.syncSnapshot(id, write), mode: "snapshot" };
      } catch (e) {
        if (gitError) throw new Error(t.zipFallbackFailed(gitError.message, (e as Error).message));
        throw e;
      }
    }
    throw new Error(t.noCredentials());
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

  private async syncSnapshot(id: string, force = false): Promise<string> {
    const dir = path.join(this.cfg.cacheDir, "snapshots", id);
    const key = `zip:${id}`;
    if (!force && existsSync(dir) && Date.now() - (this.lastSync.get(key) ?? 0) <= READ_TTL_MS) return dir;

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

  /** Forget the cached snapshot so the next read re-downloads (after changes made through the web API). */
  invalidate(id: string): void {
    this.lastSync.delete(`zip:${id}`);
  }

  /** Send files changed in a checkout back to Overleaf: git commit+push, or web upload without Git. */
  async save(id: string, co: Checkout, files: string[], message: string): Promise<string> {
    if (co.mode === "git") return this.git.commitAndPush(co.dir, files, message);
    for (const f of files) await this.web.uploadFile(id, f, await fs.readFile(safeJoin(co.dir, f)));
    return t.savedViaWeb();
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
    throw new Error(t.fileNotFound(rel));
  }
  if (isBinary(buf)) throw new Error(t.binaryFile(rel));
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
