import path from "node:path";
import { t } from "./i18n.js";

const LEVELS: Record<string, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

export interface Heading {
  command: string;
  level: number;
  title: string;
  file: string;
  /** 1-based line number. */
  line: number;
}

/** Remove a trailing LaTeX comment (an unescaped %). */
export function stripComment(line: string): string {
  return line.replace(/(^|[^\\])(\\\\)*%.*$/, (m) => m.slice(0, m.indexOf("%")));
}

/** Read a brace group starting at `open` (the index of "{"). Returns the inner text and end index. */
function readGroup(s: string, open: number): { text: string; end: number } | undefined {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return { text: s.slice(open + 1, i), end: i };
  }
  return undefined;
}

export function findMainFile(files: Map<string, string>): string | undefined {
  const hasClass = (f: string) => /^[^%]*\\documentclass/m.test(files.get(f) ?? "");
  const tex = [...files.keys()].filter((f) => f.endsWith(".tex"));
  return (
    tex.find((f) => f === "main.tex" && hasClass(f)) ??
    tex.find((f) => !f.includes("/") && hasClass(f)) ??
    tex.find(hasClass)
  );
}

function resolveInclude(files: Map<string, string>, from: string, target: string): string | undefined {
  const name = target.trim().replace(/\\/g, "/");
  const candidates = [name, `${name}.tex`];
  const dir = path.posix.dirname(from);
  if (dir !== ".") candidates.push(path.posix.join(dir, name), path.posix.join(dir, `${name}.tex`));
  return candidates.map((c) => path.posix.normalize(c)).find((c) => files.has(c));
}

const TOKEN_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\]\s*)?(?=\{)|\\(input|include|subfile)\s*\{([^}]+)\}/g;

/**
 * Build the document outline by walking from the main file through \input/\include/\subfile.
 * Files that are never included are still scanned afterwards so nothing is hidden.
 */
export function parseOutline(files: Map<string, string>, mainFile?: string): Heading[] {
  const headings: Heading[] = [];
  const visited = new Set<string>();

  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const lines = (files.get(file) ?? "").split(/\r?\n/);
    lines.forEach((raw, idx) => {
      const line = stripComment(raw);
      for (const m of line.matchAll(TOKEN_RE)) {
        if (m[1]) {
          const group = readGroup(line, (m.index ?? 0) + m[0].length);
          const title = (group?.text ?? line.slice((m.index ?? 0) + m[0].length + 1)).replace(/\s+/g, " ").trim();
          headings.push({ command: m[1], level: LEVELS[m[1]], title, file, line: idx + 1 });
        } else if (m[2]) {
          const target = resolveInclude(files, file, m[3]);
          if (target) visit(target);
        }
      }
    });
  };

  const main = mainFile ?? findMainFile(files);
  if (main) visit(main);
  for (const f of files.keys()) if (f.endsWith(".tex")) visit(f);
  return headings;
}

export function formatOutline(headings: Heading[]): string {
  if (!headings.length) return t.noHeadings();
  const min = Math.min(...headings.map((h) => h.level));
  return headings
    .map((h) => `${"  ".repeat(h.level - min)}- ${h.title}  [\\${h.command}, ${h.file}:${h.line}]`)
    .join("\n");
}

export function findHeading(headings: Heading[], title: string, file?: string): Heading {
  const pool = file ? headings.filter((h) => h.file === file) : headings;
  const needle = title.trim().toLowerCase();
  const exact = pool.filter((h) => h.title.toLowerCase() === needle);
  const matches = exact.length ? exact : pool.filter((h) => h.title.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(t.noSection(title));
  throw new Error(t.ambiguousSection(title, matches.map((h) => `- ${h.title} (${h.file}:${h.line})`).join("\n")));
}

/** Lines of a section: from its heading up to the next heading of the same or higher level in the same file. */
export function sectionRange(headings: Heading[], h: Heading, content: string): { start: number; end: number } {
  const lines = content.split(/\r?\n/);
  const next = headings.find((o) => o.file === h.file && o.line > h.line && o.level <= h.level);
  let end = next ? next.line - 1 : lines.length;
  const docEnd = lines.findIndex((l, i) => i >= h.line && /^\s*\\end\{document\}/.test(l));
  if (docEnd !== -1 && docEnd < end) end = docEnd;
  while (end > h.line && !lines[end - 1].trim()) end--;
  return { start: h.line, end };
}

export interface LogEntry {
  level: "error" | "warning" | "badbox";
  message: string;
  file?: string;
  line?: number;
}

/** Best-effort parser for pdfTeX/XeTeX/LuaTeX .log output. */
export function parseLog(log: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = log.split(/\r?\n/);
  const stack: (string | null)[] = [];
  const currentFile = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f && !/^\/(usr|opt|texlive)|texmf/.test(f)) return f.replace(/^\.\//, "");
    }
    return undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("! ")) {
      let lineNo: number | undefined;
      const context: string[] = [];
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const m = lines[j].match(/^l\.(\d+)\s?(.*)$/);
        if (m) {
          lineNo = Number(m[1]);
          if (m[2].trim()) context.push(m[2].trim());
          break;
        }
      }
      entries.push({
        level: "error",
        message: line.slice(2).trim() + (context.length ? ` — near: ${context.join(" ")}` : ""),
        file: currentFile(),
        line: lineNo,
      });
      continue;
    }

    const warn = line.match(/^((?:LaTeX|Package [\w.-]+|Class [\w.-]+)) Warning: (.*)$/);
    if (warn) {
      let message = warn[2];
      // Package warnings continue on lines prefixed with "(pkgname)" or plain text until a blank line.
      for (let j = i + 1; j < lines.length && lines[j].trim() && !/Warning:|^!/.test(lines[j]); j++) {
        message += " " + lines[j].replace(/^\([\w.-]+\)\s*/, "").trim();
        i = j;
      }
      const lineNo = message.match(/on input line (\d+)/);
      entries.push({
        level: "warning",
        message: `${warn[1]}: ${message.replace(/\s+/g, " ").trim()}`,
        file: currentFile(),
        line: lineNo ? Number(lineNo[1]) : undefined,
      });
      continue;
    }

    const badbox = line.match(/^((?:Over|Under)full \\[hv]box .*?)(?: (?:in paragraph|detected|has occurred while \\output is active))? at lines? (\d+)/);
    if (badbox) {
      entries.push({ level: "badbox", message: badbox[1], file: currentFile(), line: Number(badbox[2]) });
      continue;
    }

    // Track which file TeX is in from "(./file.tex" ... ")" nesting.
    for (let k = 0; k < line.length; k++) {
      if (line[k] === "(") {
        const m = line.slice(k + 1).match(/^"?((?:\.{0,2}\/|[A-Za-z]:\/)?[^\s()"]+\.[A-Za-z]{2,4})/);
        stack.push(m ? m[1] : null);
      } else if (line[k] === ")") {
        stack.pop();
      }
    }
  }
  return entries;
}

const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힣]/;

export function containsHangul(text: string): boolean {
  return HANGUL_RE.test(text);
}

/** Does the preamble already load something that typesets Korean? */
export function hasKoreanSupport(preamble: string): boolean {
  return /\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\b(kotex|xetexko|luatexko|xeCJK|CJKutf8|CJK)\b/.test(preamble);
}

/** Compile errors such as "Unicode character 한 (U+D55C) not set up for use with LaTeX". */
export function hasHangulErrors(entries: LogEntry[]): boolean {
  return entries.some((e) => {
    if (e.level !== "error") return false;
    const code = e.message.match(/\(U\+([0-9A-F]{4,5})\)/i);
    return code ? containsHangul(String.fromCodePoint(parseInt(code[1], 16))) : containsHangul(e.message);
  });
}

/** Insert \usepackage{pkg} after the last \usepackage in the preamble (or after \documentclass). */
export function addPackage(content: string, pkg: string): string {
  const lines = content.split("\n");
  const begin = lines.findIndex((l) => /^\s*\\begin\{document\}/.test(l));
  const preambleEnd = begin === -1 ? lines.length : begin;
  let at = -1;
  for (let i = 0; i < preambleEnd; i++) if (/^\s*\\usepackage/.test(lines[i])) at = i;
  if (at === -1) at = lines.findIndex((l) => /^\s*\\documentclass/.test(l));
  const eol = lines[Math.max(at, 0)]?.endsWith("\r") ? "\r" : "";
  lines.splice(at + 1, 0, `\\usepackage{${pkg}}${eol}`);
  return lines.join("\n");
}

export function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}
