import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { t } from "./i18n.js";

const execFileAsync = promisify(execFile);

/** Thin wrapper around the git CLI for Overleaf's Git bridge. */
export class GitClient {
  constructor(private readonly cfg: Config) {}

  get enabled(): boolean {
    return !!this.cfg.gitToken;
  }

  private env(): NodeJS.ProcessEnv {
    const auth = Buffer.from(`git:${this.cfg.gitToken ?? ""}`).toString("base64");
    // Pass credentials through env-scoped git config so the token never lands in
    // .git/config, the remote URL, or the process argument list.
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    };
  }

  async run(args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        env: this.env(),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; message: string; code?: string };
      if (err.code === "ENOENT") throw new Error(t.gitMissing());
      let detail = (err.stderr || err.message).trim();
      if (this.cfg.gitToken) detail = detail.split(this.cfg.gitToken).join("***");
      if (/no git access/i.test(detail)) {
        detail += `\n${t.gitNoAccess()}`;
      } else if (/401|403|Authentication failed|could not read Username/i.test(detail)) {
        detail += `\n${t.gitAuth()}`;
      }
      throw new Error(`git ${args[0]} failed: ${detail}`);
    }
  }

  async clone(projectId: string, dir: string): Promise<void> {
    await this.run(["clone", "--quiet", `${this.cfg.gitUrl}/${projectId}`, dir]);
  }

  /** Bring the working copy up to date with Overleaf, discarding nothing that was pushed. */
  async pull(dir: string): Promise<void> {
    try {
      await this.run(["pull", "--rebase", "--quiet"], dir);
    } catch (e) {
      // A failed rebase leaves the repo mid-operation; restore a clean state matching the remote.
      await this.run(["rebase", "--abort"], dir).catch(() => {});
      await this.run(["fetch", "--quiet"], dir);
      await this.run(["reset", "--hard", "--quiet", "@{u}"], dir);
      throw new Error(t.gitResetRetry((e as Error).message));
    }
  }

  /** Commit the given paths and push. Returns a short description of what happened. */
  async commitAndPush(dir: string, paths: string[], message: string): Promise<string> {
    // Paths already removed with `git rm`/`git mv` are staged and gone from disk; naming them
    // again makes `git add` fail with "pathspec did not match any files".
    const present = paths.filter((p) => existsSync(path.join(dir, p)));
    try {
      if (present.length) await this.run(["add", "--all", "--", ...present], dir);
      const status = await this.run(["status", "--porcelain"], dir);
      if (!status.trim()) return t.gitNothingToCommit();

      await this.run(
        ["-c", `user.name=${this.cfg.authorName}`, "-c", `user.email=${this.cfg.authorEmail}`, "commit", "--quiet", "-m", message],
        dir,
      );
    } catch (e) {
      // Don't leave staged or half-committed changes behind to break the next pull.
      await this.run(["reset", "--hard", "--quiet", "@{u}"], dir).catch(() => {});
      throw e;
    }
    try {
      await this.run(["push", "--quiet"], dir);
    } catch {
      // Someone edited the project in the meantime: rebase onto their changes and try once more.
      try {
        await this.run(["pull", "--rebase", "--quiet"], dir);
        await this.run(["push", "--quiet"], dir);
      } catch (e) {
        await this.run(["rebase", "--abort"], dir).catch(() => {});
        await this.run(["fetch", "--quiet"], dir).catch(() => {});
        await this.run(["reset", "--hard", "--quiet", "@{u}"], dir).catch(() => {});
        throw new Error(t.gitPushFailed((e as Error).message));
      }
    }
    const sha = (await this.run(["rev-parse", "--short", "HEAD"], dir)).trim();
    return t.gitPushed(sha);
  }
}
