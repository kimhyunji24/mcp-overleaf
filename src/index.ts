#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { planMarkdownWrite, type ApplyPlan } from "./apply.js";
import { loadConfig } from "./config.js";
import { GitClient } from "./git.js";
import { setLang, t } from "./i18n.js";
import {
  addPackage,
  findHeading,
  findMainFile,
  formatOutline,
  hasHangulErrors,
  hasKoreanSupport,
  lineOfOffset,
  parseLog,
  parseOutline,
  sectionRange,
  type LogEntry,
} from "./latex.js";
import { ProjectStore, listFiles, readAllText, readText, safeJoin } from "./project.js";
import { OverleafWeb, type CompileResult } from "./web.js";

const VERSION = "0.1.0";

/**
 * Build an isolated MCP server for one credential set. The HTTP entrypoint calls
 * this once per authenticated request so user A can never inherit user B's
 * Overleaf token or project cache. The stdio entrypoint uses the process config.
 */
export function createServer(cfg: ReturnType<typeof loadConfig>): McpServer {
setLang(cfg.lang);
const web = new OverleafWeb(cfg);
const git = new GitClient(cfg);
const store = new ProjectStore(cfg, web, git);

const server = new McpServer({ name: "mcp-overleaf", version: VERSION });

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
  .describe("Project ID or Overleaf project URL (or project name in web mode). Defaults to OVERLEAF_PROJECT_ID.");


server.registerTool(
  "list_projects",
  {
    title: "List Overleaf projects",
    description: "List the Overleaf projects in your account with their IDs. Web mode only (opt-in, see README).",
    inputSchema: {
      include_archived: z.boolean().optional().describe("Also list archived and trashed projects."),
    },
  },
  async ({ include_archived }) => run(async () => {
    const projects = (await web.listProjects()).filter((p) => include_archived || (!p.archived && !p.trashed));
    if (!projects.length) return t.noProjectsFound();
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
      return files.length ? files.join("\n") : t.emptyProject();
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
      return `${t.lineRange(rel, start, end, lines.length)}\n` + lines.slice(start - 1, end).join("\n");
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
      return `${t.mainFile(main)}\n\n` + formatOutline(parseOutline(files, main));
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
      return `${t.lineRange(h.file, start, end)}\n${body}`;
    });
  }),
);

server.registerTool(
  "write_file",
  {
    title: "Write a file",
    description:
      "Create or overwrite a file in the Overleaf project and save it to Overleaf. Prefer edit_file for changing part of an existing file. Uses Git; falls back to the opt-in web mode if enabled.",
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
      return store.save(id, co, [rel], commit_message ?? `Update ${rel} via mcp-overleaf`);
    });
  }),
);

server.registerTool(
  "edit_file",
  {
    title: "Edit a file",
    description:
      "Replace an exact string in a project file and save it to Overleaf. old_string must match exactly once unless replace_all is set. Uses Git; falls back to the opt-in web mode if enabled.",
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
      if (count === 0) throw new Error(t.oldNotFound(rel));
      if (count > 1 && !replace_all) throw new Error(t.oldAmbiguous(count, rel));
      let updated = replace_all ? text.split(oldS).join(norm(new_string)) : text.replace(oldS, () => norm(new_string));
      if (crlf) updated = updated.replace(/\n/g, "\r\n");
      await fs.writeFile(safeJoin(co.dir, rel), updated, "utf8");
      const result = await store.save(id, co, [rel], commit_message ?? `Edit ${rel} via mcp-overleaf`);
      return t.replaced(replace_all ? count : 1, rel, result);
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
      "Writing uses Git; falls back to the opt-in web mode if enabled.",
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
      if ((markdown === undefined) === (md_path === undefined)) throw new Error(t.markdownSource());
      const source = markdown ?? (await fs.readFile(path.resolve(md_path!), "utf8"));
      const opts = { markdown: source, path: rel, section, mode, topLevel: top_level };

      const report = (plan: ApplyPlan, result?: string) => {
        const parts = [dry_run ? t.dryRun(plan.description) : t.planDone(plan.description, result ?? "")];
        if (plan.missingPackages.length) {
          parts.push(t.missingPackages(plan.missingPackages.map((p) => `\\usepackage{${p}}`).join(", ")));
        }
        if (plan.needsKorean) parts.push(t.koreanSetupHint());
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
        const message = commit_message ?? `${section ? `Update section "${section}"` : `Write ${plan.file}`} from Markdown via mcp-overleaf`;
        return report(plan, await store.save(id, co, [plan.file], message));
      });
    }),
);

/** Project-relative path in Overleaf's form: forward slashes, no leading/trailing slash. */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

server.registerTool(
  "delete_file",
  {
    title: "Delete a file or folder",
    description:
      "Delete a file or folder from the Overleaf project. Deleted files can be restored from Overleaf's History. Uses Git; falls back to the opt-in web mode if enabled.",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("File or folder path relative to the project root."),
      commit_message: z.string().optional(),
    },
  },
  async ({ project, path: rel, commit_message }) =>
    run(async () => {
      const id = await store.resolve(project);
      const target = normPath(rel);
      return store.write(id, async (co) => {
        const full = safeJoin(co.dir, target);
        if (co.mode === "git") {
          if (!existsSync(full)) throw new Error(t.notFoundInProject(target));
          await git.run(["rm", "-r", "--quiet", "--", target], co.dir);
          return t.deleted(target, await git.commitAndPush(co.dir, [target], commit_message ?? `Delete ${target} via mcp-overleaf`));
        }
        const entity = (await web.getEntities(id)).get(target);
        if (!entity) throw new Error(t.notFoundInProject(target));
        await web.deleteEntity(id, entity);
        store.invalidate(id);
        return t.deletedWeb(entity.type === "folder", target);
      });
    }),
);

server.registerTool(
  "move_file",
  {
    title: "Rename or move a file",
    description:
      "Rename and/or move a file or folder within the project, e.g. intro.tex → sections/introduction.tex. Missing target folders are created. Remember to update \\input/\\include references. Uses Git; falls back to the opt-in web mode if enabled.",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("Current path."),
      new_path: z.string().describe("New path."),
      commit_message: z.string().optional(),
    },
  },
  async ({ project, path: rel, new_path, commit_message }) =>
    run(async () => {
      const id = await store.resolve(project);
      const from = normPath(rel);
      const to = normPath(new_path);
      if (from === to) throw new Error(t.samePath());
      return store.write(id, async (co) => {
        safeJoin(co.dir, from);
        const toFull = safeJoin(co.dir, to);
        if (co.mode === "git") {
          await fs.mkdir(path.dirname(toFull), { recursive: true });
          await git.run(["mv", "--", from, to], co.dir);
          const result = await git.commitAndPush(co.dir, [from, to], commit_message ?? `Move ${from} to ${to} via mcp-overleaf`);
          return t.moved(from, to, result);
        }

        const entities = await web.getEntities(id);
        const entity = entities.get(from);
        if (!entity) throw new Error(t.notFoundInProject(from));
        if (entities.has(to)) throw new Error(t.alreadyExists(to));

        const fromDir = path.posix.dirname(from);
        const toDir = path.posix.dirname(to);
        if (fromDir !== toDir) {
          // Walk/create the target folder chain.
          let folderId = await web.getRootFolderId(id);
          let prefix = "";
          for (const seg of toDir === "." ? [] : toDir.split("/")) {
            prefix = prefix ? `${prefix}/${seg}` : seg;
            const existing = entities.get(prefix);
            if (existing && existing.type !== "folder") throw new Error(t.notAFolder(prefix));
            folderId = existing?.id ?? (await web.createFolder(id, folderId, seg));
          }
          await web.moveEntity(id, entity, folderId);
        }
        if (path.posix.basename(from) !== path.posix.basename(to)) {
          await web.renameEntity(id, entity, path.posix.basename(to));
        }
        store.invalidate(id);
        return t.moved(from, to);
      });
    }),
);

/** A new comment thread ID in the same 24-hex shape Overleaf's editor generates. */
function newThreadId(): string {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, "0") + randomBytes(8).toString("hex");
}

server.registerTool(
  "add_comment",
  {
    title: "Add a review comment",
    description:
      "Start a new review comment thread on a passage of a .tex file, as if highlighting it in the Overleaf editor. Web mode only (opt-in, see README).",
    inputSchema: {
      project: projectArg,
      path: z.string().describe("File the passage is in."),
      text: z.string().min(1).describe("Exact passage to comment on (as it appears in the file)."),
      comment: z.string().min(1).describe("Comment text."),
      occurrence: z.number().int().positive().optional().describe("Which match to use if `text` appears more than once (1-based)."),
    },
  },
  async ({ project, path: rel, text, comment, occurrence }) =>
    run(async () => {
      const id = await store.resolve(project);
      const target = normPath(rel);
      const anchor = text.replace(/\r\n/g, "\n");
      return web.withRealtime(id, async (rt) => {
        const entity = rt.entities.get(target);
        if (!entity || entity.type !== "doc") throw new Error(t.notEditableDoc(target));
        const doc = await rt.joinDoc(entity.id);
        try {
          const positions: number[] = [];
          for (let i = doc.text.indexOf(anchor); i !== -1; i = doc.text.indexOf(anchor, i + 1)) positions.push(i);
          if (!positions.length) throw new Error(t.passageNotFound(target));
          if (positions.length > 1 && !occurrence) throw new Error(t.passageAmbiguous(positions.length, target));
          const p = positions[(occurrence ?? 1) - 1];
          if (p === undefined) throw new Error(t.onlyOccurrences(positions.length));

          const threadId = newThreadId();
          await web.postThreadMessage(id, threadId, comment);
          await rt.applyOps(entity.id, doc.version, [{ c: anchor, p, t: threadId }]);
          return t.commentAdded(`${target}:${lineOfOffset(doc.text, p)}`, anchor.slice(0, 80), threadId);
        } finally {
          await rt.leaveDoc(entity.id);
        }
      });
    }),
);

server.registerTool(
  "reply_comment",
  {
    title: "Reply to a comment",
    description: "Add a reply to an existing comment thread (thread IDs come from get_comments). Web mode only (opt-in, see README).",
    inputSchema: {
      project: projectArg,
      thread_id: z.string().regex(/^[0-9a-f]{24}$/i).describe("Thread ID from get_comments."),
      content: z.string().min(1).describe("Reply text."),
    },
  },
  async ({ project, thread_id, content }) =>
    run(async () => {
      const id = await store.resolve(project);
      const threads = await web.getThreads(id);
      if (!threads[thread_id]) throw new Error(t.noThread(thread_id));
      await web.postThreadMessage(id, thread_id, content);
      return t.replied(thread_id);
    }),
);

server.registerTool(
  "resolve_comment",
  {
    title: "Resolve or reopen a comment",
    description: "Mark a comment thread as resolved, or reopen a resolved one. Web mode only (opt-in, see README).",
    inputSchema: {
      project: projectArg,
      thread_id: z.string().regex(/^[0-9a-f]{24}$/i).describe("Thread ID from get_comments."),
      reopen: z.boolean().optional().describe("Reopen instead of resolve."),
    },
  },
  async ({ project, thread_id, reopen }) =>
    run(async () => {
      const id = await store.resolve(project);
      const doc = (await web.getRanges(id)).find((d) => d.ranges?.comments?.some((c) => c.op.t === thread_id));
      if (!doc) throw new Error(t.threadNotAttached(thread_id));
      await web.setThreadResolved(id, doc.id, thread_id, !reopen);
      return t.resolved(!!reopen, thread_id);
    }),
);

function formatEntries(entries: LogEntry[], limit: number): string {
  const shown = entries.slice(0, limit).map((e) => {
    const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : e.line ? `line ${e.line}` : "";
    return `- ${loc ? `[${loc}] ` : ""}${e.message}`;
  });
  if (entries.length > limit) shown.push(t.andMore(entries.length - limit));
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
      "Compile the project on Overleaf and report errors and warnings with file and line numbers. Web mode only (opt-in, see README).",
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

    const parts = [t.compileStatus(result.status, hasPdf), t.compileCounts(errors.length, warnings.length, badboxes.length)];
    if (result.status === "timedout") parts.push(t.compileTimeout());
    if (result.status === "too-recently-compiled") parts.push(t.compileRateLimited());
    if (hasHangulErrors(entries)) parts.push(t.koreanCompileHint());
    if (errors.length) parts.push(`\n${t.errorsHeader()}\n${formatEntries(errors, 50)}`);
    if (include_warnings && warnings.length) parts.push(`\n${t.warningsHeader()}\n${formatEntries(warnings, 40)}`);
    if (include_badboxes && badboxes.length) parts.push(`\n${t.badboxesHeader()}\n${formatEntries(badboxes, 40)}`);
    if (raw_log_lines > 0) parts.push(`\n${t.logTailHeader()}\n${log.split(/\r?\n/).slice(-raw_log_lines).join("\n")}`);
    if (!log) parts.push(`\n${t.noLog()}`);
    return parts.join("\n");
  }),
);

server.registerTool(
  "download_pdf",
  {
    title: "Download compiled PDF",
    description: "Compile the project and save the PDF to a local path. Web mode only (opt-in, see README).",
    inputSchema: {
      project: projectArg,
      output_path: z.string().optional().describe("Where to save the PDF. Defaults to the cache directory."),
    },
  },
  async ({ project, output_path }) => run(async () => {
    const id = await store.resolve(project);
    const result = await web.compile(id);
    const pdf = result.outputFiles.find((f) => f.path === "output.pdf");
    if (!pdf) throw new Error(t.noPdf(result.status));
    const data = Buffer.from(await (await web.fetchOutputFile(result, pdf)).arrayBuffer());
    const target = path.resolve(output_path ?? path.join(cfg.cacheDir, "pdf", `${id}.pdf`));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return t.pdfSaved((data.length / 1024).toFixed(0), target);
  }),
);

server.registerTool(
  "get_comments",
  {
    title: "Get review comments",
    description:
      "List review comment threads in the project with the commented text, file, line and replies. Web mode only (opt-in, see README).",
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
          `- [${where}]${thread.resolved ? t.resolvedTag() : ""} "${c.op.c.slice(0, 200)}"\n` +
            `  ${t.threadLabel(c.op.t)}\n${messages.join("\n")}`,
        );
      }
    }
    return out.length ? out.join("\n\n") : t.noOpenComments();
  }),
);

server.registerTool(
  "setup_paper_language",
  {
    title: "Set up the paper language",
    description:
      "Prepare the project for writing in Korean or English. For \"ko\": adds \\usepackage{kotex} to the main file's preamble " +
      "(if no Korean package is loaded yet) and switches the compiler to XeLaTeX (needs the opt-in web mode; otherwise it says how to " +
      "do it in Overleaf). For \"en\": reports that no setup is needed. Run this before writing Korean text, or when compile " +
      "reports \"Unicode character\" errors for Korean.",
    inputSchema: {
      project: projectArg,
      language: z.enum(["ko", "en"]).describe("Paper language."),
      main_file: z.string().optional().describe("Main .tex file. Detected automatically if omitted."),
    },
  },
  async ({ project, language, main_file }) =>
    run(async () => {
      if (language === "en") return t.englishSetup();
      const id = await store.resolve(project);
      const parts: string[] = [];
      await store.write(id, async (co) => {
        const files = await readAllText(co.dir);
        const main = main_file ?? findMainFile(files);
        if (!main || !files.has(main)) throw new Error(t.noMainFile());
        const content = files.get(main)!;
        if (hasKoreanSupport(content.split(/\\begin\{document\}/)[0])) {
          parts.push(t.koreanAlreadySet(main));
          return;
        }
        await fs.writeFile(safeJoin(co.dir, main), addPackage(content, "kotex"), "utf8");
        parts.push(t.kotexAdded(main, await store.save(id, co, [main], `Add kotex for Korean via mcp-overleaf`)));
      });
      if (web.enabled) {
        await web.setCompiler(id, "xelatex");
        parts.push(t.compilerSet("XeLaTeX"));
      } else {
        parts.push(t.compilerManual("XeLaTeX"));
      }
      return parts.join("\n");
    }),
);

return server;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = createServer(cfg);
  const webEnabled = cfg.webOptIn && !!cfg.sessionCookie;
  if (webEnabled) console.error(t.startWebOn());
  else if (cfg.sessionCookie) console.error(t.startCookieIgnored());
  if (!cfg.gitToken && !webEnabled) console.error(t.startNoGit());
  await server.connect(new StdioServerTransport());
  console.error(
    `mcp-overleaf ${VERSION} running (git: ${cfg.gitToken ? "on" : "off"}, web mode: ${webEnabled ? "on" : "off"}, lang: ${cfg.lang})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
