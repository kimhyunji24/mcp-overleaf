import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToLatex } from "./markdown.js";
import { planMarkdownWrite } from "./apply.js";

const md = (s: string, topLevel?: string) => markdownToLatex(s, { topLevel }).latex.trim();

test("headings map from the shallowest level, with labels and unnumbered", () => {
  assert.equal(md("## Intro {#sec:intro}\n\n### Detail\n\n## Thanks {-}"), [
    "\\section{Intro}\\label{sec:intro}",
    "",
    "\\subsection{Detail}",
    "",
    "\\section*{Thanks}",
  ].join("\n"));
  assert.equal(md("# A\n## B", "chapter"), "\\chapter{A}\n\n\\section{B}");
});

test("inline formatting, escaping and math protection", () => {
  assert.equal(
    md("**Bold** and *it* and `a_b` cost 50% & more_info, with $x_1^2 + \\alpha$ kept."),
    "\\textbf{Bold} and \\emph{it} and \\texttt{a\\_b} cost 50\\% \\& more\\_info, with $x_1^2 + \\alpha$ kept.",
  );
  assert.equal(md('He said "hi" ... ok'), "He said ``hi'' \\ldots{} ok");
  assert.equal(md("Raw \\textsc{Keep_this} and \\cite{x}."), "Raw \\textsc{Keep_this} and \\cite{x}.");
  assert.equal(md("snake_case_name stays"), "snake\\_case\\_name stays");
});

test("citations, cross references and footnotes", () => {
  assert.equal(md("As shown [@smith2020; @lee2021]."), "As shown \\cite{smith2020,lee2021}.");
  assert.equal(md("See [@smith2020, p. 3]."), "See \\cite[p. 3]{smith2020}.");
  assert.equal(md("Results in @fig:main and @tbl:res."), "Results in \\ref{fig:main} and \\ref{tbl:res}.");
  assert.equal(md("Text[^1] here.\n\n[^1]: A *note*."), "Text\\footnote{A \\emph{note}.} here.");
});

test("links, figures, display math", () => {
  const r = markdownToLatex("[site](https://x.org/a%20b#c)\n\n![A cat](figs/cat.png){#fig:cat width=50%}\n\n$$\nE = mc^2\n$$ {#eq:e}");
  assert.equal(
    r.latex.trim(),
    [
      "\\href{https://x.org/a\\%20b\\#c}{site}",
      "",
      "\\begin{figure}[htbp]",
      "\\centering",
      "\\includegraphics[width=0.5\\linewidth]{figs/cat.png}",
      "\\caption{A cat}",
      "\\label{fig:cat}",
      "\\end{figure}",
      "",
      "\\begin{equation}",
      "E = mc^2",
      "\\label{eq:e}",
      "\\end{equation}",
    ].join("\n"),
  );
  assert.deepEqual(r.packages, ["graphicx", "hyperref"]);
});

test("nested lists", () => {
  assert.equal(
    md("- one\n- two\n  1. a\n  2. b\n- three"),
    [
      "\\begin{itemize}",
      "  \\item one",
      "  \\item two",
      "  ",
      "  \\begin{enumerate}",
      "    \\item a",
      "    \\item b",
      "  \\end{enumerate}",
      "  \\item three",
      "\\end{itemize}",
    ].join("\n"),
  );
});

test("tables with captions", () => {
  assert.equal(
    md("| Model | Acc |\n|:--|--:|\n| A_1 | 90% |\n\nTable: Results {#tbl:res}"),
    [
      "\\begin{table}[htbp]",
      "\\centering",
      "\\caption{Results}\\label{tbl:res}",
      "\\begin{tabular}{lr}",
      "\\hline",
      "Model & Acc \\\\",
      "\\hline",
      "A\\_1 & 90\\% \\\\",
      "\\hline",
      "\\end{tabular}",
      "\\end{table}",
    ].join("\n"),
  );
});

test("code blocks and raw LaTeX environments pass through", () => {
  assert.equal(md("```\na_b & c\n```"), "\\begin{verbatim}\na_b & c\n\\end{verbatim}");
  const raw = "\\begin{algorithm}\n\\caption{x_y}\n\\end{algorithm}";
  assert.equal(md(raw), raw);
});

const project = new Map([
  [
    "main.tex",
    [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      "\\section{Introduction}",
      "\\label{sec:intro}",
      "Old intro.",
      "",
      "\\section{Method}",
      "Old method.",
      "\\end{document}",
    ].join("\n"),
  ],
]);

test("replacing a section body keeps heading and label", () => {
  const plan = planMarkdownWrite(project, { markdown: "New *intro* with [link](http://a.b).", section: "intro" });
  assert.equal(plan.file, "main.tex");
  assert.equal(
    plan.content,
    [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      "\\section{Introduction}",
      "\\label{sec:intro}",
      "",
      "New \\emph{intro} with \\href{http://a.b}{link}.",
      "",
      "\\section{Method}",
      "Old method.",
      "\\end{document}",
    ].join("\n"),
  );
  assert.deepEqual(plan.missingPackages, ["hyperref"]);
});

test("Markdown with its own heading replaces the heading, at the section's level", () => {
  const plan = planMarkdownWrite(project, { markdown: "# Approach\n\nText.\n\n## Detail", section: "Method" });
  assert.match(plan.content, /\\section\{Approach\}\n\nText\.\n\n\\subsection\{Detail\}\n\n\\end\{document\}$/);
  assert.doesNotMatch(plan.content, /Old method/);
});

test("refuses to overwrite the main file; append goes before \\end{document}", () => {
  assert.throws(() => planMarkdownWrite(project, { markdown: "x", path: "main.tex" }), /preamble/);
  const plan = planMarkdownWrite(project, { markdown: "## Extra", path: "main.tex", mode: "append" });
  assert.match(plan.content, /Old method\.\n\n\\section\{Extra\}\n\n\\end\{document\}$/);
});
