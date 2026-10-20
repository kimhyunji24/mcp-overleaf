import { findHeading, findMainFile, parseOutline, sectionRange } from "./latex.js";
import { HEADING_COMMANDS, markdownToLatex } from "./markdown.js";

export interface ApplyOptions {
  markdown: string;
  /** Target file. Required unless `section` is given. */
  path?: string;
  /** Title of an existing section to replace. */
  section?: string;
  mode?: "overwrite" | "append";
  topLevel?: string;
}

export interface ApplyPlan {
  file: string;
  content: string;
  latex: string;
  description: string;
  missingPackages: string[];
}

const HEADING_START = new RegExp(`^\\\\(${HEADING_COMMANDS.join("|")})\\*?\\{`);

/** Packages the converted LaTeX needs that the main file's preamble does not load. */
export function missingPackages(files: Map<string, string>, packages: string[]): string[] {
  const main = findMainFile(files);
  if (!main) return [];
  const preamble = (files.get(main) ?? "").split(/\\begin\{document\}/)[0];
  const loaded = new Set<string>();
  for (const m of preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(",")) loaded.add(p.trim());
  }
  // Many classes and packages already provide what we need.
  if (loaded.has("biblatex")) loaded.add("natbib");
  if (loaded.has("graphics")) loaded.add("graphicx");
  if (/\\documentclass[^{]*\{(beamer|memoir|revtex4-2|IEEEtran|acmart|elsarticle)\}/.test(preamble)) {
    loaded.add("graphicx");
    loaded.add("hyperref");
  }
  return packages.filter((p) => !loaded.has(p));
}

/** Work out the new content of the target file for a Markdown write, without touching disk. */
export function planMarkdownWrite(files: Map<string, string>, opts: ApplyOptions): ApplyPlan {
  if (opts.section) {
    const headings = parseOutline(files);
    const h = findHeading(headings, opts.section, opts.path);
    const original = files.get(h.file) ?? "";
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const lines = original.split(/\r?\n/);
    const { latex, packages } = markdownToLatex(opts.markdown, { topLevel: opts.topLevel ?? h.command });
    const { end } = sectionRange(headings, h, original);

    // Markdown that starts with its own heading replaces the heading line too;
    // otherwise keep the existing heading (and a \label right after it).
    let keep = h.line - 1;
    const replacesHeading = HEADING_START.test(latex);
    if (!replacesHeading) {
      keep = h.line;
      if (/^\s*\\label\{/.test(lines[keep] ?? "")) keep++;
    }
    const after = lines.slice(end);
    const body = latex.trimEnd().split("\n");
    if (after.length && after[0].trim()) body.push("");
    const content = [...lines.slice(0, keep), ...(replacesHeading ? [] : [""]), ...body, ...after].join(eol);
    return {
      file: h.file,
      content,
      latex,
      description: `Replaced section "${h.title}" (${h.file} lines ${h.line}-${end})${replacesHeading ? " including its heading" : ""}`,
      missingPackages: missingPackages(files, packages),
    };
  }

  if (!opts.path) throw new Error("Pass `path` (target .tex file) or `section` (existing section to replace).");
  if (!/\.(tex|ltx)$/i.test(opts.path)) throw new Error(`Target should be a .tex file, got ${opts.path}`);
  const { latex, packages } = markdownToLatex(opts.markdown, { topLevel: opts.topLevel ?? "section" });
  const existing = files.get(opts.path);
  const missing = missingPackages(files, packages);

  if (opts.mode === "append" && existing !== undefined) {
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    const insert = latex.replace(/\n/g, eol);
    const endDoc = existing.search(/^[ \t]*\\end\{document\}/m);
    const content =
      endDoc >= 0
        ? existing.slice(0, endDoc).replace(/\s*$/, eol + eol) + insert + eol + existing.slice(endDoc)
        : existing.replace(/\s*$/, eol + eol) + insert;
    return { file: opts.path, content, latex, description: `Appended to ${opts.path}`, missingPackages: missing };
  }

  if (existing !== undefined && /^[^%\n]*\\documentclass/m.test(existing)) {
    throw new Error(
      `${opts.path} is the main file (it has \\documentclass); overwriting it would delete the preamble. ` +
        `Write to a separate file (e.g. sections/intro.tex and \\input it), replace a \`section\`, or use mode "append".`,
    );
  }
  return {
    file: opts.path,
    content: latex,
    latex,
    description: `${existing === undefined ? "Created" : "Overwrote"} ${opts.path}`,
    missingPackages: missing,
  };
}
