// End-to-end check against a real Overleaf account.
// Usage: npm run build && npm run smoke            (reads credentials from .env)
//        npm run smoke -- --read-only             (skip anything that pushes)
//
// Writes only to sections/mcp-smoke-test.tex in OVERLEAF_PROJECT_ID. Use a throwaway project.

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const readOnly = process.argv.includes("--read-only");
const hasGit = !!process.env.OVERLEAF_GIT_TOKEN;
const hasCookie = !!process.env.OVERLEAF_SESSION_COOKIE && /^(1|true|yes|on)$/i.test(process.env.OVERLEAF_ENABLE_WEB ?? "");
const project = process.env.OVERLEAF_PROJECT_ID;
const TEST_FILE = "sections/mcp-smoke-test.tex";

console.log(`git token: ${hasGit ? "set" : "missing"}, web mode: ${hasCookie ? "on" : "off"}, project: ${project || "missing"}\n`);
if (!project) {
  console.error("Set OVERLEAF_PROJECT_ID in .env");
  process.exit(1);
}

const server = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
let buf = "";
server.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

const results = [];
async function step(name, args, { needs, check } = {}) {
  if (needs === "git" && !hasGit) return results.push([name, "SKIP", "no git token"]);
  if (needs === "cookie" && !hasCookie) return results.push([name, "SKIP", "web mode off"]);
  if (needs === "write" && (readOnly || (!hasGit && !hasCookie))) return results.push([name, "SKIP", readOnly ? "--read-only" : "no git token or web mode"]);
  const started = Date.now();
  const msg = await rpc("tools/call", { name: name.split(" ")[0], arguments: args });
  const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error);
  const failed = !!msg.error || msg.result?.isError || (check && !check(text));
  console.log(`=== ${name} (${Date.now() - started} ms) ${failed ? "FAIL" : "ok"}\n${text.slice(0, 1500)}\n`);
  results.push([name, failed ? "FAIL" : "ok", ""]);
  return text;
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const stamp = new Date().toISOString();
await step("list_projects", {}, { needs: "cookie" });
await step("list_files", { project });
await step("get_outline", { project });
await step("write_markdown (dry run)", {
  project,
  path: TEST_FILE,
  dry_run: true,
  markdown: "## Smoke test {#sec:smoke}\n\nHello *Overleaf* [@key]. See @fig:x.",
});
await step(
  "write_markdown",
  {
    project,
    path: TEST_FILE,
    markdown: `## MCP smoke test {#sec:smoke}\n\nWritten by **mcp-overleaf** at ${stamp}.\n\n- one\n- two\n\n$$\nE = mc^2\n$$ {#eq:smoke}`,
  },
  { needs: "write", check: (t) => /pushed|Saved to Overleaf/.test(t) },
);
await step("read_file", { project, path: TEST_FILE }, { needs: "write", check: (t) => t.includes(stamp) });
await step(
  "edit_file",
  { project, path: TEST_FILE, old_string: "\\item two", new_string: "\\item two (edited)" },
  { needs: "write", check: (t) => /pushed|Saved to Overleaf/.test(t) },
);
await step(
  "write_markdown (section replace)",
  { project, section: "MCP smoke test", path: TEST_FILE, markdown: "Body replaced at " + stamp + "." },
  { needs: "write", check: (t) => /Replaced section/.test(t) },
);
await step("compile", { project, draft: true }, { needs: "cookie" });
await step("get_comments", { project, include_resolved: true }, { needs: "cookie" });
await step(
  "download_pdf",
  { project, output_path: path.join(os.tmpdir(), "mcp-overleaf-smoke.pdf") },
  { needs: "cookie" },
);

server.kill();
console.log("Summary");
for (const [name, status, why] of results) console.log(`  ${status.padEnd(4)} ${name}${why ? ` (${why})` : ""}`);
if (!readOnly && (hasGit || hasCookie)) console.log(`\nYou can delete ${TEST_FILE} from the test project afterwards.`);
process.exit(results.some((r) => r[1] === "FAIL") ? 1 : 0);
