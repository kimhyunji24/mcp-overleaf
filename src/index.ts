#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { planMarkdownWrite, type ApplyPlan } from "./apply.js";
import { loadConfig } from "./config.js";
import { GitClient } from "./git.js";
import {
  findHeading,
  findMainFile,
  formatOutline,
  lineOfOffset,
  parseLog,
  parseOutline,
  sectionRange,
  type LogEntry,
} from "./latex.js";
import { ProjectStore, listFiles, readAllText, readText, safeJoin } from "./project.js";
import { OverleafWeb, type CompileResult } from "./web.js";

const VERSION = "0.1.0";

const cfg = loadConfig();
const web = new OverleafWeb(cfg);
const git = new GitClient(cfg);
const store = new ProjectStore(cfg, web, git);

const server = new McpServer({ name: "overleaf-mcp", version: VERSION });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Run a tool body so thrown errors become MCP tool errors instead of protocol failures. */
async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (e) {
    return { content: [{ type: "text", text: (e as Error).message }], isError: true };
  }
}

const projectArg = z
  .string()
  .optional()
  .describe("Project ID, Overleaf project URL, or project name. Defaults to OVERLEAF_PROJECT_ID.");

server.registerTool(
  "list_projects",
  {
    title: "List Overleaf projects",
    description: "List the Overleaf projects in your account with their IDs. Requires OVERLEAF_SESSION_COOKIE.",
    inputSchema: {
      include_archived: z.boolean().optional().describe("Also list archived and trashed projects."),
    },
  },
  async ({ include_archived }) => run(async () => {
    const projects = (await web.listProjects()).filter((p) => include_archived || (!p.archived && !p.trashed));
    if (!projects.length) return "No projects found.";
    return projects
      .map((p) => {
        const extra = [p.accessLevel, p.lastUpdated && `updated ${p.lastUpdated}`, p.archived && "archived", p.trashed && "trashed"];
        const meta = extra.filter(Boolean).join(", ");
        return `- ${p.name} (${p.id})${meta ? ` — ${meta}` : ""}`;
      })
      .join("\n");
  }),
);

server.registerTool(
  "list_files",
  {
    title: "List project files",
    description: "List all files in an Overleaf project.",
    inputSchema: { project: projectArg },
  },
  async ({ project }) => run(async () => {
    const id = await store.resolve(project);
    return store.read(id, async (co) => {
      const files = await listFiles(co.dir);
      return (files.length ? files.join("\n") : "(empty project)");
    });
  }),
);

server.registerTool(
  "read_file",
  {
    title: "Read a file",
    description: "Read a text file from an Overleaf project, optionally limited to a line range.",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("Path relative to the project root, e.g. main.tex or sections/intro.tex"),
      start_line: z.number().int().positive().optional().describe("First line to return (1-based)."),
      end_line: z.number().int().positive().optional().describe("Last line to return (inclusive)."),
    },
  },
  async ({ project, path: rel, start_line, end_line }) => run(async () => {
    const id = await store.resolve(project);
    return store.read(id, async (co) => {
      const content = await readText(co.dir, rel);
      if (!start_line && !end_line) return content;
      const lines = content.split(/\r?\n/);
      const start = start_line ?? 1;
      const end = Math.min(end_line ?? lines.length, lines.length);
      return `[${rel} lines ${start}-${end} of ${lines.length}]\n` + lines.slice(start - 1, end).join("\n");
    });
  }),
);

server.registerTool(
  "get_outline",
  {
    title: "Get document outline",
    description:
      "Show the section structure (\\part, \\chapter, \\section, ...) of the document, following \\input/\\include from the main file, with file and line numbers.",
    inputSchema: {
      project: projectArg,
      main_file: z.string().optional().describe("Main .tex file. Detected automatically if omitted."),
    },
  },
  async ({ project, main_file }) => run(async () => {
    const id = await store.resolve(project);
    return store.read(id, async (co) => {
      const files = await readAllText(co.dir);
      const main = main_file ?? findMainFile(files);
      return `Main file: ${main ?? "(not found)"}\n\n` + formatOutline(parseOutline(files, main));
    });
  }),
);

server.registerTool(
  "read_section",
  {
    title: "Read a section",
    description: "Read the LaTeX source of one section by its title (case-insensitive; partial titles work if unambiguous).",
    inputSchema: {
      project: projectArg,
      title: z.string().describe("Section title, e.g. 'Related Work'"),
      file: z.string().optional().describe("Restrict the search to this file."),
    },
  },
  async ({ project, title, file }) => run(async () => {
    const id = await store.resolve(project);
    return store.read(id, async (co) => {
      const files = await readAllText(co.dir);
      const headings = parseOutline(files);
      const h = findHeading(headings, title, file);
      const content = files.get(h.file) ?? "";
      const { start, end } = sectionRange(headings, h, content);
      const body = content.split(/\r?\n/).slice(start - 1, end).join("\n");
      return `[${h.file} lines ${start}-${end}]\n${body}`;
    });
  }),
);

server.registerTool(
  "write_file",
  {
    title: "Write a file",
    description:
      "Create or overwrite a file in the Overleaf project and save it to Overleaf. Prefer edit_file for changing part of an existing file. Uses Git when available, otherwise the web session cookie.",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("Path relative to the project root."),
      content: z.string().describe("Full new file content."),
      commit_message: z.string().optional(),
    },
  },
  async ({ project, path: rel, content, commit_message }) => run(async () => {
    const id = await store.resolve(project);
    return store.write(id, async (co) => {
      const full = safeJoin(co.dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      return store.save(id, co, [rel], commit_message ?? `Update ${rel} via overleaf-mcp`);
    });
  }),
);

server.registerTool(
  "edit_file",
  {
    title: "Edit a file",
    description:
      "Replace an exact string in a project file and save it to Overleaf. old_string must match exactly once unless replace_all is set. Uses Git when available, otherwise the web session cookie.",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("Path relative to the project root."),
      old_string: z.string().min(1).describe("Exact text to replace, including whitespace."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
      commit_message: z.string().optional(),
    },
  },
  async ({ project, path: rel, old_string, new_string, replace_all, commit_message }) => run(async () => {
    const id = await store.resolve(project);
    return store.write(id, async (co) => {
      const content = await readText(co.dir, rel);
      // Files from Overleaf may use CRLF; match on normalized newlines but keep the file's style.
      const crlf = content.includes("\r\n");
      const norm = (s: string) => s.replace(/\r\n/g, "\n");
      const text = norm(content);
      const oldS = norm(old_string);
      const count = text.split(oldS).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${rel}. Read the file again; it may have changed on Overleaf.`);
      if (count > 1 && !replace_all) {
        throw new Error(`old_string occurs ${count} times in ${rel}. Add surrounding context to make it unique, or set replace_all.`);
      }
      let updated = replace_all ? text.split(oldS).join(norm(new_string)) : text.replace(oldS, () => norm(new_string));
      if (crlf) updated = updated.replace(/\n/g, "\r\n");
      await fs.writeFile(safeJoin(co.dir, rel), updated, "utf8");
      const result = await store.save(id, co, [rel], commit_message ?? `Edit ${rel} via overleaf-mcp`);
      return `Replaced ${replace_all ? count : 1} occurrence(s) in ${rel}. ${result}`;
    });
  }),
);

server.registerTool(
  "write_markdown",
  {
    title: "Write Markdown to Overleaf",
    description:
      "Write in Markdown, publish as LaTeX. Converts Markdown to LaTeX and writes it into the project: a new/overwritten .tex file, " +
      "an existing section replaced by title, or appended to a file. Supports headings ({#sec:label}, {-} for unnumbered), " +
      "$math$ and $$display$$ ({#eq:label}), citations [@key; @key2, p. 3], cross refs @fig:x/@sec:x/@eq:x/@tbl:x, " +
      "figures ![caption](img.png){#fig:x width=60%}, pipe tables with 'Table: caption {#tbl:x}', footnotes, lists, code, " +
      "and raw LaTeX (\\commands and \\begin..\\end blocks pass through). Set dry_run to preview the LaTeX first. " +
      "Writing uses Git when available, otherwise the web session cookie.",
    inputSchema: {
      project: projectArg,
      markdown: z.string().optional().describe("Markdown text. Use this or md_path."),
      md_path: z.string().optional().describe("Absolute path of a local .md file to convert instead of `markdown`."),
      path: z.string().optional().describe("Target .tex file in the project. Required unless `section` is given."),
      section: z
        .string()
        .optional()
        .describe(
          "Title of an existing section to replace. If the Markdown starts with a heading it replaces the heading too; otherwise only the body.",
        ),
      mode: z.enum(["overwrite", "append"]).optional().describe("For a file target: overwrite (default) or append before \\end{document}."),
      top_level: z
        .enum(["part", "chapter", "section", "subsection", "subsubsection", "paragraph"])
        .optional()
        .describe("LaTeX command for the shallowest Markdown heading. Defaults to section, or the replaced section's own level."),
      dry_run: z.boolean().optional().describe("Only return the converted LaTeX and what would change; do not push."),
      commit_message: z.string().optional(),
    },
  },
  async ({ project, markdown, md_path, path: rel, section, mode, top_level, dry_run, commit_message }) =>
    run(async () => {
      if ((markdown === undefined) === (md_path === undefined)) throw new Error("Pass exactly one of `markdown` or `md_path`.");
      const source = markdown ?? (await fs.readFile(path.resolve(md_path!), "utf8"));
      const opts = { markdown: source, path: rel, section, mode, topLevel: top_level };

      const report = (plan: ApplyPlan, result?: string) => {
        const parts = [dry_run ? `Dry run — would apply: ${plan.description}` : `${plan.description}. ${result}`];
        if (plan.missingPackages.length) {
          parts.push(
            `Note: the preamble does not load ${plan.missingPackages.map((p) => `\\usepackage{${p}}`).join(", ")}; add it or compilation may fail.`,
          );
        }
        if (dry_run) parts.push(`\n${plan.latex}`);
        return parts.join("\n");
      };

      // Converting to a fresh file needs no project access at all.
      if (dry_run && !section && !project && !cfg.defaultProject) {
        return report(planMarkdownWrite(new Map(), { ...opts, path: rel ?? "preview.tex" }));
      }
      const id = await store.resolve(project);
      if (dry_run) return store.read(id, async (co) => report(planMarkdownWrite(await readAllText(co.dir), opts)));
      return store.write(id, async (co) => {
        const plan = planMarkdownWrite(await readAllText(co.dir), opts);
        const full = safeJoin(co.dir, plan.file);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, plan.content, "utf8");
        const message = commit_message ?? `${section ? `Update section "${section}"` : `Write ${plan.file}`} from Markdown via overleaf-mcp`;
        return report(plan, await store.save(id, co, [plan.file], message));
      });
    }),
);

function formatEntries(entries: LogEntry[], limit: number): string {
  const shown = entries.slice(0, limit).map((e) => {
    const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : e.line ? `line ${e.line}` : "";
    return `- ${loc ? `[${loc}] ` : ""}${e.message}`;
  });
  if (entries.length > limit) shown.push(`- ... and ${entries.length - limit} more`);
  return shown.join("\n");
}

async function compileAndLog(id: string, draft?: boolean): Promise<{ result: CompileResult; log: string }> {
  const result = await web.compile(id, { draft });
  const logFile = result.outputFiles.find((f) => f.path === "output.log");
  const log = logFile ? await (await web.fetchOutputFile(result, logFile)).text() : "";
  return { result, log };
}

server.registerTool(
  "compile",
  {
    title: "Compile project",
    description:
      "Compile the project on Overleaf and report errors and warnings with file and line numbers. Requires OVERLEAF_SESSION_COOKIE.",
    inputSchema: {
      project: projectArg,
      draft: z.boolean().optional().describe("Fast draft compile (no images)."),
      include_warnings: z.boolean().optional().describe("List warnings (default true)."),
      include_badboxes: z.boolean().optional().describe("List overfull/underfull box warnings (default false)."),
      raw_log_lines: z.number().int().min(0).max(2000).optional().describe("Also return the last N lines of the raw log."),
    },
  },
  async ({ project, draft, include_warnings = true, include_badboxes = false, raw_log_lines = 0 }) => run(async () => {
    const id = await store.resolve(project);
    const { result, log } = await compileAndLog(id, draft);
    const entries = parseLog(log);
    const errors = entries.filter((e) => e.level === "error");
    const warnings = entries.filter((e) => e.level === "warning");
    const badboxes = entries.filter((e) => e.level === "badbox");
    const hasPdf = result.outputFiles.some((f) => f.path === "output.pdf");

    const parts = [
      `Status: ${result.status}${hasPdf ? " (PDF produced)" : " (no PDF)"}`,
      `Errors: ${errors.length}, warnings: ${warnings.length}, bad boxes: ${badboxes.length}`,
    ];
    if (result.status === "timedout") parts.push("The compile timed out. Try draft mode or check for heavy figures.");
    if (result.status === "too-recently-compiled") parts.push("Overleaf rate-limited this compile; wait a few seconds and retry.");
    if (errors.length) parts.push(`\nErrors:\n${formatEntries(errors, 50)}`);
    if (include_warnings && warnings.length) parts.push(`\nWarnings:\n${formatEntries(warnings, 40)}`);
    if (include_badboxes && badboxes.length) parts.push(`\nBad boxes:\n${formatEntries(badboxes, 40)}`);
    if (raw_log_lines > 0) parts.push(`\nLog tail:\n${log.split(/\r?\n/).slice(-raw_log_lines).join("\n")}`);
    if (!log) parts.push("\n(No log file was returned.)");
    return parts.join("\n");
  }),
);

server.registerTool(
  "download_pdf",
  {
    title: "Download compiled PDF",
    description: "Compile the project and save the PDF to a local path. Requires OVERLEAF_SESSION_COOKIE.",
    inputSchema: {
      project: projectArg,
      output_path: z.string().optional().describe("Where to save the PDF. Defaults to the cache directory."),
    },
  },
  async ({ project, output_path }) => run(async () => {
    const id = await store.resolve(project);
    const result = await web.compile(id);
    const pdf = result.outputFiles.find((f) => f.path === "output.pdf");
    if (!pdf) throw new Error(`Compile finished with status "${result.status}" and produced no PDF. Run compile to see errors.`);
    const data = Buffer.from(await (await web.fetchOutputFile(result, pdf)).arrayBuffer());
    const target = path.resolve(output_path ?? path.join(cfg.cacheDir, "pdf", `${id}.pdf`));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return `Saved ${(data.length / 1024).toFixed(0)} KB PDF to ${target}`;
  }),
);

server.registerTool(
  "get_comments",
  {
    title: "Get review comments",
    description:
      "List review comment threads in the project with the commented text, file, line and replies. Requires OVERLEAF_SESSION_COOKIE.",
    inputSchema: {
      project: projectArg,
      include_resolved: z.boolean().optional().describe("Include resolved threads (default false)."),
    },
  },
  async ({ project, include_resolved }) => run(async () => {
    const id = await store.resolve(project);
    const [threads, ranges] = await Promise.all([web.getThreads(id), web.getRanges(id)]);
    const files = await store.read(id, async (co) => readAllText(co.dir)).catch(() => new Map<string, string>());

    const out: string[] = [];
    for (const doc of ranges) {
      for (const c of doc.ranges?.comments ?? []) {
        const thread = threads[c.op.t];
        if (!thread || (thread.resolved && !include_resolved)) continue;

        // Ranges only carry the doc ID; find the file whose text matches at the comment offset.
        let where = `doc ${doc.id}`;
        for (const [file, content] of files) {
          const text = content.replace(/\r\n/g, "\n");
          if (text.substr(c.op.p, c.op.c.length) === c.op.c) {
            where = `${file}:${lineOfOffset(text, c.op.p)}`;
            break;
          }
        }
        const messages = (thread.messages ?? []).map((m) => {
          const who = [m.user?.first_name, m.user?.last_name].filter(Boolean).join(" ") || m.user?.email || "unknown";
          const when = new Date(m.timestamp).toISOString().slice(0, 16).replace("T", " ");
          return `    ${who} (${when}): ${m.content}`;
        });
        out.push(
          `- [${where}]${thread.resolved ? " (resolved)" : ""} on "${c.op.c.slice(0, 200)}"\n` +
            `  thread ${c.op.t}\n${messages.join("\n")}`,
        );
      }
    }
    return out.length ? out.join("\n\n") : "No open comments.";
  }),
);


async function main(): Promise<void> {
  if (!cfg.gitToken && !cfg.sessionCookie) {
    console.error("overleaf-mcp: warning: neither OVERLEAF_GIT_TOKEN nor OVERLEAF_SESSION_COOKIE is set; only write_markdown dry runs will work.");
  }
  await server.connect(new StdioServerTransport());
  console.error(
    `overleaf-mcp ${VERSION} running (git: ${git.enabled ? "on" : "off"}, web session: ${web.enabled ? "on" : "off"})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
