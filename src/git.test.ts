import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { GitClient } from "./git.js";

const PROJECT_ID = "0123456789abcdef01234567";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A local bare repo standing in for Overleaf's Git bridge, plus a fresh clone of it. */
async function setup(t: { after: (fn: () => void) => void }) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-overleaf-git-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const remote = path.join(tmp, "remote", PROJECT_ID);
  mkdirSync(remote, { recursive: true });
  git(["init", "--quiet", "--bare"], remote);

  const seed = path.join(tmp, "seed");
  git(["clone", "--quiet", remote, seed], tmp);
  mkdirSync(path.join(seed, "sections"));
  writeFileSync(path.join(seed, "main.tex"), "\\documentclass{article}\n");
  writeFileSync(path.join(seed, "intro.tex"), "Intro\n");
  writeFileSync(path.join(seed, "sections", "a.tex"), "A\n");
  git(["add", "--all"], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", "origin", "HEAD"], seed);

  const saved = { url: process.env.OVERLEAF_GIT_URL, token: process.env.OVERLEAF_GIT_TOKEN };
  process.env.OVERLEAF_GIT_URL = `file://${path.join(tmp, "remote")}`;
  process.env.OVERLEAF_GIT_TOKEN = "test-token";
  const client = new GitClient(loadConfig());
  process.env.OVERLEAF_GIT_URL = saved.url;
  process.env.OVERLEAF_GIT_TOKEN = saved.token;
  if (saved.url === undefined) delete process.env.OVERLEAF_GIT_URL;
  if (saved.token === undefined) delete process.env.OVERLEAF_GIT_TOKEN;

  const dir = path.join(tmp, "checkout");
  await client.clone(PROJECT_ID, dir);
  const remoteFiles = () => git(["ls-tree", "-r", "--name-only", "HEAD"], remote).trim().split("\n");
  return { client, dir, remoteFiles };
}

test("commitAndPush pushes a git mv even though the old path no longer exists", async (t) => {
  const { client, dir, remoteFiles } = await setup(t);
  mkdirSync(path.join(dir, "chapters"));
  await client.run(["mv", "--", "intro.tex", "chapters/intro.tex"], dir);
  await client.commitAndPush(dir, ["intro.tex", "chapters/intro.tex"], "move");
  assert.deepEqual(remoteFiles().sort(), ["chapters/intro.tex", "main.tex", "sections/a.tex"]);
});

test("commitAndPush pushes a git rm of a file or folder", async (t) => {
  const { client, dir, remoteFiles } = await setup(t);
  await client.run(["rm", "-r", "--quiet", "--", "sections"], dir);
  await client.commitAndPush(dir, ["sections"], "delete folder");
  await client.run(["rm", "-r", "--quiet", "--", "intro.tex"], dir);
  await client.commitAndPush(dir, ["intro.tex"], "delete file");
  assert.deepEqual(remoteFiles(), ["main.tex"]);
});

test("a failed commit resets the working copy so the next write works", async (t) => {
  const { client, dir, remoteFiles } = await setup(t);
  const hook = path.join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await client.run(["mv", "--", "intro.tex", "renamed.tex"], dir);
  await assert.rejects(client.commitAndPush(dir, ["intro.tex", "renamed.tex"], "move"), /commit/);
  assert.equal(git(["status", "--porcelain"], dir), "");

  rmSync(hook);
  await client.pull(dir);
  await client.run(["rm", "--quiet", "--", "intro.tex"], dir);
  await client.commitAndPush(dir, ["intro.tex"], "delete");
  assert.deepEqual(remoteFiles().sort(), ["main.tex", "sections/a.tex"]);
});
