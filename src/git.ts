import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";

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
      if (err.code === "ENOENT") throw new Error("git is not installed or not on PATH.");
      let detail = (err.stderr || err.message).trim();
      if (this.cfg.gitToken) detail = detail.split(this.cfg.gitToken).join("***");
      if (/no git access/i.test(detail)) {
        detail +=
          "\nOverleaf Git integration needs the project owner to have a paid or institutional plan." +
          " Without it, the only alternative is the opt-in web mode; read the README for its risks first.";
      } else if (/401|403|Authentication failed|could not read Username/i.test(detail)) {
        detail += "\nCheck OVERLEAF_GIT_TOKEN. Overleaf Git integration requires a paid plan (or institutional access).";
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
      throw new Error(`${(e as Error).message}\nLocal copy was reset to match Overleaf; please retry.`);
    }
  }

  /** Commit the given paths and push. Returns a short description of what happened. */
  async commitAndPush(dir: string, paths: string[], message: string): Promise<string> {
    await this.run(["add", "--all", "--", ...paths], dir);
    const status = await this.run(["status", "--porcelain"], dir);
    if (!status.trim()) return "No changes to commit (file already had this content).";

    await this.run(
      ["-c", `user.name=${this.cfg.authorName}`, "-c", `user.email=${this.cfg.authorEmail}`, "commit", "--quiet", "-m", message],
      dir,
    );
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
        throw new Error(`Could not push to Overleaf; your change was NOT saved. ${(e as Error).message}`);
      }
    }
    const sha = (await this.run(["rev-parse", "--short", "HEAD"], dir)).trim();
    return `Committed and pushed ${sha} to Overleaf.`;
  }
}
