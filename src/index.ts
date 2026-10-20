#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { GitClient } from "./git.js";
import {
  findHeading,
  findMainFile,
  formatOutline,
  parseOutline,
  sectionRange,
} from "./latex.js";
import { ProjectStore, listFiles, readAllText, readText, safeJoin } from "./project.js";
import { OverleafWeb } from "./web.js";

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
      "Create or overwrite a file in the Overleaf project and push it (via Git). Prefer edit_file for changing part of an existing file. Requires OVERLEAF_GIT_TOKEN.",
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
      return git.commitAndPush(co.dir, [rel], commit_message ?? `Update ${rel} via overleaf-mcp`);
    });
  }),
);

server.registerTool(
  "edit_file",
  {
    title: "Edit a file",
    description:
      "Replace an exact string in a project file and push the change (via Git). old_string must match exactly once unless replace_all is set. Requires OVERLEAF_GIT_TOKEN.",
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
      const result = await git.commitAndPush(co.dir, [rel], commit_message ?? `Edit ${rel} via overleaf-mcp`);
      return `Replaced ${replace_all ? count : 1} occurrence(s) in ${rel}. ${result}`;
    });
  }),
);


async function main(): Promise<void> {
  if (!cfg.gitToken && !cfg.sessionCookie) {
    console.error("overleaf-mcp: warning: neither OVERLEAF_GIT_TOKEN nor OVERLEAF_SESSION_COOKIE is set; all tools will fail.");
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
