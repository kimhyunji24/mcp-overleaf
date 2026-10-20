/**
 * Markdown → LaTeX converter tuned for writing papers.
 *
 * Supports CommonMark basics plus a few Pandoc-style extensions that matter for LaTeX:
 *   - headings with labels / unnumbered:  ## Method {#sec:method}   ## Acknowledgements {-}
 *   - math: $x$, $$...$$ (optionally followed by {#eq:label}), \(...\), \[...\]
 *   - citations [@smith2020; @lee2021, p. 3] and cross references @fig:x / @sec:x / @eq:x / @tbl:x
 *   - figures: ![Caption](img.png){#fig:x width=60%} on its own line
 *   - pipe tables with an optional "Table: caption {#tbl:x}" line
 *   - footnotes [^1] with [^1]: definitions
 *   - raw LaTeX: \commands{...} inline and \begin{env}...\end{env} blocks pass through untouched
 */

export const HEADING_COMMANDS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];

export interface MarkdownOptions {
  /** LaTeX command used for the shallowest Markdown heading in the input. Default "section". */
  topLevel?: string;
}

export interface ConvertResult {
  latex: string;
  /** Packages the output relies on (hyperref for links, graphicx for figures, ...). */
  packages: string[];
}

interface Ctx {
  levels: string[];
  minLevel: number;
  footnotes: Map<string, string>;
  packages: Set<string>;
}

export function markdownToLatex(markdown: string, opts: MarkdownOptions = {}): ConvertResult {
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n(---|\.\.\.)\n/, ""); // YAML front matter
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  const footnotes = new Map<string, string>();
  text = text.replace(/^\[\^([^\]]+)\]:[ \t]*(.*(?:\n(?: {2,}|\t).*)*)/gm, (_, id: string, body: string) => {
    footnotes.set(id, body.replace(/\n\s+/g, " ").trim());
    return "";
  });

  const lines = text.split("\n");
  const headingLevels = lines
    .filter((l, i) => /^#{1,6}\s/.test(l) && !insideFence(lines, i))
    .map((l) => l.match(/^#+/)![0].length);

  const top = Math.max(0, HEADING_COMMANDS.indexOf(opts.topLevel ?? "section"));
  const ctx: Ctx = {
    levels: HEADING_COMMANDS.slice(top),
    minLevel: headingLevels.length ? Math.min(...headingLevels) : 1,
    footnotes,
    packages: new Set(),
  };
  const latex = convertBlocks(lines, ctx).replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return { latex, packages: [...ctx.packages].sort() };
}

function insideFence(lines: string[], index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i++) if (/^\s*(```|~~~)/.test(lines[i])) open = !open;
  return open;
}

// ---------------------------------------------------------------- blocks

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ATTR_RE = /\s*\{([^{}]*)\}\s*$/;

function parseAttrs(attr: string | undefined): { id?: string; unnumbered: boolean; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  let id: string | undefined;
  let unnumbered = false;
  for (const tok of (attr ?? "").split(/\s+/).filter(Boolean)) {
    if (tok.startsWith("#")) id = tok.slice(1);
    else if (tok === "-" || tok === ".unnumbered") unnumbered = true;
    else if (tok.includes("=")) kv.set(tok.slice(0, tok.indexOf("=")), tok.slice(tok.indexOf("=") + 1).replace(/^"|"$/g, ""));
  }
  return { id, unnumbered, kv };
}

function convertBlocks(lines: string[], ctx: Ctx): string {
  const out: string[] = [];
  let i = 0;

  const isBlockStart = (line: string, next?: string): boolean =>
    /^\s*(```|~~~)/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*\$\$/.test(line) ||
    /^\s*\\\[/.test(line) ||
    /^\s*\\begin\{/.test(line) ||
    /^\s*>/.test(line) ||
    LIST_RE.test(line) ||
    /^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP_RE.test(next));

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`\\begin{verbatim}\n${body.join("\n")}\n\\end{verbatim}`);
      continue;
    }

    // Display math: $$ ... $$ {#eq:x}
    if (/^\s*\$\$/.test(line)) {
      let raw = line.trim().slice(2);
      let closed = raw.includes("$$");
      while (!closed && ++i < lines.length) {
        raw += "\n" + lines[i];
        closed = lines[i].includes("$$");
      }
      i++;
      const end = raw.lastIndexOf("$$");
      const body = (end >= 0 ? raw.slice(0, end) : raw).trim();
      const { id } = parseAttrs(end >= 0 ? raw.slice(end + 2).match(/\{([^}]*)\}/)?.[1] : undefined);
      out.push(
        id
          ? `\\begin{equation}\n${body}\n\\label{${id}}\n\\end{equation}`
          : `\\[\n${body}\n\\]`,
      );
      continue;
    }

    // Raw LaTeX blocks pass through untouched
    const env = line.match(/^\s*\\begin\{([^}]+)\}/);
    if (env || /^\s*\\\[/.test(line)) {
      const closer = env ? `\\end{${env[1]}}` : "\\]";
      const opener = env ? `\\begin{${env[1]}}` : "\\[";
      const body: string[] = [];
      let depth = 0;
      while (i < lines.length) {
        const l = lines[i++];
        body.push(l);
        depth += l.split(opener).length - 1;
        depth -= l.split(closer).length - 1;
        if (depth <= 0) break;
      }
      out.push(body.join("\n"));
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      i++;
      let title = heading[2];
      const attr = title.match(ATTR_RE);
      if (attr) title = title.slice(0, attr.index).trim();
      const { id, unnumbered } = parseAttrs(attr?.[1]);
      const idx = Math.min(heading[1].length - ctx.minLevel, ctx.levels.length - 1);
      const cmd = ctx.levels[Math.max(0, idx)] ?? "subparagraph";
      out.push(`\\${cmd}${unnumbered ? "*" : ""}{${inline(title, ctx)}}${id ? `\\label{${id}}` : ""}`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      i++;
      out.push("\\noindent\\rule{\\linewidth}{0.4pt}");
      continue;
    }

    // Block quote
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`\\begin{quote}\n${convertBlocks(body, ctx).trim()}\n\\end{quote}`);
      continue;
    }

    // Lists
    if (LIST_RE.test(line)) {
      const block: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim()) {
          if (!LIST_RE.test(l) && !/^\s/.test(l) && block.length && !block[block.length - 1].trim()) break;
          if (!LIST_RE.test(l) && !/^\s/.test(l) && isBlockStart(l, lines[i + 1])) break;
        } else if (i + 1 < lines.length && !(LIST_RE.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) {
          break;
        }
        block.push(l);
        i++;
      }
      out.push(convertList(block, ctx));
      continue;
    }

    // Tables
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      let caption: string | undefined;
      const prev = out.length ? out[out.length - 1] : "";
      const capBefore = prev.match(/^%%TABLECAPTION%%(.*)$/s);
      if (capBefore) {
        out.pop();
        caption = capBefore[1];
      }
      const rows: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(lines[i++]);
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const capAfter = lines[j]?.match(/^\s*(?:Table)?:\s+(.*)$/);
      if (!caption && capAfter) {
        caption = capAfter[1];
        i = j + 1;
      }
      out.push(convertTable(rows, caption, ctx));
      continue;
    }

    // "Table: caption" that precedes a table
    const tableCap = line.match(/^\s*Table:\s+(.*)$/);
    if (tableCap) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j + 1 < lines.length && lines[j].includes("|") && TABLE_SEP_RE.test(lines[j + 1])) {
        out.push(`%%TABLECAPTION%%${tableCap[1]}`);
        i = j;
        continue;
      }
    }

    // Stand-alone image → figure
    const img = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)(\{[^}]*\})?\s*$/);
    if (img) {
      i++;
      out.push(figure(img[1], img[2], img[4]?.slice(1, -1), ctx));
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) {
      para.push(lines[i++]);
    }
    // Hard line breaks: two trailing spaces or a trailing backslash
    const joined = para
      .map((l, k) => (k < para.length - 1 && / {2,}$/.test(l) ? l.trimEnd() + "\u0001" : l.trimEnd()))
      .join("\n");
    out.push(inline(joined, ctx).replace(/\u0001/g, " \\\\"));
  }

  return out.join("\n\n");
}

function convertList(block: string[], ctx: Ctx): string {
  const first = block.find((l) => LIST_RE.test(l))!.match(LIST_RE)!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];

  for (const l of block) {
    const m = l.match(LIST_RE);
    if (m && m[1].length <= baseIndent) {
      items.push([m[3]]);
    } else if (items.length) {
      // Continuation or nested content: strip up to the item's content indentation.
      items[items.length - 1].push(l.replace(new RegExp(`^ {0,${baseIndent + 4}}`), ""));
    }
  }

  const env = ordered ? "enumerate" : "itemize";
  const body = items.map((it) => {
    const task = it[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (task) it[0] = task[2];
    const content = convertBlocks(it, ctx).trim();
    const label = task ? (task[1] === " " ? "[$\\square$]" : "[$\\boxtimes$]") : "";
    if (task) ctx.packages.add("amssymb");
    return `  \\item${label} ${content.replace(/\n/g, "\n  ")}`;
  });
  return `\\begin{${env}}\n${body.join("\n")}\n\\end{${env}}`;
}

function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function convertTable(rows: string[], caption: string | undefined, ctx: Ctx): string {
  const header = splitRow(rows[0]);
  const align = splitRow(rows[1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "c" : c.endsWith(":") ? "r" : "l",
  );
  while (align.length < header.length) align.push("l");
  const fmt = (cells: string[]) => cells.map((c) => inline(c, ctx)).join(" & ") + " \\\\";
  const tabular = [
    `\\begin{tabular}{${align.join("")}}`,
    "\\hline",
    fmt(header),
    "\\hline",
    ...rows.slice(2).map((r) => fmt(splitRow(r))),
    "\\hline",
    "\\end{tabular}",
  ].join("\n");

  if (caption === undefined) return `\\begin{center}\n${tabular}\n\\end{center}`;
  const attr = caption.match(ATTR_RE);
  const { id } = parseAttrs(attr?.[1]);
  const text = attr ? caption.slice(0, attr.index).trim() : caption.trim();
  return [
    "\\begin{table}[htbp]",
    "\\centering",
    `\\caption{${inline(text, ctx)}}${id ? `\\label{${id}}` : ""}`,
    tabular,
    "\\end{table}",
  ].join("\n");
}

function widthValue(w: string | undefined): string {
  if (!w) return "0.8\\linewidth";
  const pct = w.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return `${Number(pct[1]) / 100}\\linewidth`;
  if (/^0?\.\d+$|^1(\.0+)?$/.test(w)) return `${w}\\linewidth`;
  return w;
}

function figure(caption: string, src: string, attr: string | undefined, ctx: Ctx): string {
  ctx.packages.add("graphicx");
  const { id, kv } = parseAttrs(attr);
  const graphic = `\\includegraphics[width=${widthValue(kv.get("width"))}]{${src}}`;
  if (!caption && !id) return `\\begin{center}\n${graphic}\n\\end{center}`;
  return [
    "\\begin{figure}[htbp]",
    "\\centering",
    graphic,
    caption ? `\\caption{${inline(caption, ctx)}}` : "",
    id ? `\\label{${id}}` : "",
    "\\end{figure}",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- inline

const ESCAPES: Record<string, string> = {
  "&": "\\&",
  "%": "\\%",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

function escapeText(s: string): string {
  return s.replace(/[&%#_~^]/g, (c) => ESCAPES[c]);
}

function escapeUrl(url: string): string {
  return url.replace(/[%#&]/g, (c) => `\\${c}`);
}

function escapeVerb(s: string): string {
  return s.replace(/[\\{}&%$#_~^]/g, (c) =>
    c === "\\" ? "\\textbackslash{}" : c === "~" ? "\\textasciitilde{}" : c === "^" ? "\\textasciicircum{}" : `\\${c}`,
  );
}

function inline(src: string, ctx: Ctx): string {
  const slots: string[] = [];
  const hold = (latex: string) => `\u0000${slots.push(latex) - 1}\u0000`;
  let s = src;

  // Order matters: protect code, math and raw LaTeX before anything else touches them.
  s = s.replace(/(`+)([\s\S]+?)\1/g, (_, __, code: string) => hold(`\\texttt{${escapeVerb(code.trim())}}`));
  s = s.replace(/\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|(?<![\\$])\$(?=\S)(?:\\\$|[^$\n])+?(?<=\S)\$(?!\d)/g, (m) => hold(m));
  s = s.replace(/\\\$/g, () => hold("\\$"));
  s = s.replace(/\\[&%#_{}]/g, (m) => hold(m));
  s = s.replace(/\\[a-zA-Z@]+\*?(?:\[[^\]\n]*\])*(?:\{(?:[^{}]|\{[^{}]*\})*\})*/g, (m) => hold(m));

  // Footnotes
  s = s.replace(/\[\^([^\]]+)\]/g, (m, id: string) => {
    const body = ctx.footnotes.get(id);
    return body === undefined ? m : hold(`\\footnote{${inline(body, ctx)}}`);
  });
  // Inline footnotes ^[text]
  s = s.replace(/\^\[([^\]]+)\]/g, (_, body: string) => hold(`\\footnote{${inline(body, ctx)}}`));

  // Citations: [@a; @b, p. 3] / [see @a]
  s = s.replace(/\[([^\[\]]*@[\w:.\-/]+[^\[\]]*)\](?!\()/g, (m, inner: string) => {
    const parts = inner.split(";").map((p) => p.trim());
    const keys: string[] = [];
    let pre = "";
    let post = "";
    for (const [n, p] of parts.entries()) {
      const k = p.match(/^(.*?)-?@([\w:.\-/]+)(.*)$/);
      if (!k) return m;
      keys.push(k[2]);
      if (n === 0 && k[1].trim()) pre = k[1].trim();
      if (n === parts.length - 1 && k[3].replace(/^,/, "").trim()) post = k[3].replace(/^,/, "").trim();
    }
    const opt = pre ? `[${escapeText(pre)}][${escapeText(post)}]` : post ? `[${escapeText(post)}]` : "";
    if (pre) ctx.packages.add("natbib");
    return hold(`\\cite${opt}{${keys.join(",")}}`);
  });
  // Cross references
  // Labels end at the last word character, so Korean particles can follow directly: "@fig:arch를".
  s = s.replace(/(?<![\w@])@((?:fig|sec|eq|tbl|tab|lst|thm|lem|def|app):[\w:.\-]*\w)/g, (_, label: string) =>
    hold(`\\ref{${label}}`),
  );
  // Bare citations @key in text
  s = s.replace(/(?<![\w@\\])@([A-Za-z][\w:.\-]*\w)/g, (_, key: string) => hold(`\\cite{${key}}`));

  // Images and links
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)(\{[^}]*\})?/g, (_, __, url: string, attr?: string) => {
    ctx.packages.add("graphicx");
    const { kv } = parseAttrs(attr?.slice(1, -1));
    return hold(`\\includegraphics[width=${widthValue(kv.get("width"))}]{${url}}`);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => {
    ctx.packages.add("hyperref");
    return hold(`\\href{${escapeUrl(url)}}{${inline(label, ctx)}}`);
  });
  s = s.replace(/<((?:https?|ftp|mailto):[^>\s]+)>/g, (_, url: string) => {
    ctx.packages.add("hyperref");
    return hold(`\\url{${url}}`);
  });

  // Emphasis
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, (_, __, t: string) => `\u0002B${t}\u0003`);
  s = s.replace(/(?<![\w*])\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*(?![\w*])/g, (_, t: string) => `\u0002I${t}\u0003`);
  s = s.replace(/(?<![\w\\])_(?=\S)([\s\S]+?)(?<=\S)_(?!\w)/g, (_, t: string) => `\u0002I${t}\u0003`);
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, (_, t: string) => {
    ctx.packages.add("ulem");
    return `\u0002S${t}\u0003`;
  });

  s = escapeText(s);

  // Typography
  s = s.replace(/"(?=\S)([^"\n]*?)(?<=\S)"/g, "``$1''");
  s = s.replace(/(^|[\s(\[])'(?=\S)/g, "$1`");
  s = s.replace(/\.\.\./g, "\\ldots{}");

  s = s
    .replace(/\u0002B/g, "\\textbf{")
    .replace(/\u0002I/g, "\\emph{")
    .replace(/\u0002S/g, "\\sout{")
    .replace(/\u0003/g, "}");

  // Restore protected slots (they may nest).
  for (let n = 0; n < 5 && s.includes("\u0000"); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_, k: string) => slots[Number(k)]);
  return s;
}
