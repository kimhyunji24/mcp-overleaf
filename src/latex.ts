import path from "node:path";

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
  if (!headings.length) return "No sectioning commands found.";
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
  if (!matches.length) throw new Error(`No section matching "${title}". Use get_outline to see section titles.`);
  throw new Error(
    `"${title}" matches several sections; be more specific or pass \`file\`:\n` +
      matches.map((h) => `- ${h.title} (${h.file}:${h.line})`).join("\n"),
  );
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
