import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLang, setLang, t } from "./i18n.js";
import { addPackage, hasHangulErrors, hasKoreanSupport, findHeading, parseOutline } from "./latex.js";
import { markdownToLatex } from "./markdown.js";
import { planMarkdownWrite } from "./apply.js";

test("OVERLEAF_LANG picks the response language", () => {
  assert.equal(parseLang(undefined), "en");
  assert.equal(parseLang("ko"), "ko");
  assert.equal(parseLang("ko-KR"), "ko");
  assert.equal(parseLang("en"), "en");
  try {
    setLang("ko");
    assert.equal(t.noProjectsFound(), "프로젝트가 없습니다.");
    assert.throws(() => findHeading(parseOutline(new Map([["a.tex", "\\section{A}"]])), "zzz"), /일치하는 섹션이 없습니다/);
    setLang("en");
    assert.equal(t.noProjectsFound(), "No projects found.");
  } finally {
    setLang("en");
  }
});

test("Korean Markdown: particles right after references, citations and emphasis", () => {
  const md = (s: string) => markdownToLatex(s).latex.trim();
  assert.equal(md("@fig:arch를 보면 **모델**은 [@kim2024]에서 제안한 *방법*이다."), "\\ref{fig:arch}를 보면 \\textbf{모델}은 \\cite{kim2024}에서 제안한 \\emph{방법}이다.");
  assert.equal(md("## 서론 {#sec:intro}\n\n\"인용\"과 50% 향상"), "\\section{서론}\\label{sec:intro}\n\n``인용''과 50\\% 향상");
});

test("Korean support detection and kotex insertion", () => {
  assert.equal(hasKoreanSupport("\\documentclass{article}\n\\usepackage{kotex}"), true);
  assert.equal(hasKoreanSupport("\\usepackage[hangul]{kotex}"), true);
  assert.equal(hasKoreanSupport("\\usepackage{amsmath,xeCJK}"), true);
  assert.equal(hasKoreanSupport("\\usepackage{amsmath}"), false);

  assert.equal(
    addPackage("\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nx\n\\end{document}", "kotex"),
    "\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{kotex}\n\\begin{document}\nx\n\\end{document}",
  );
  assert.equal(addPackage("\\documentclass{article}\n\\begin{document}", "kotex"), "\\documentclass{article}\n\\usepackage{kotex}\n\\begin{document}");
});

test("Hangul compile errors are recognized", () => {
  assert.equal(hasHangulErrors([{ level: "error", message: "LaTeX Error: Unicode character 현 (U+D604)" }]), true);
  assert.equal(hasHangulErrors([{ level: "error", message: "LaTeX Error: Unicode character é (U+00E9)" }]), false);
  assert.equal(hasHangulErrors([{ level: "warning", message: "Unicode character 현 (U+D604)" }]), false);
});

test("write_markdown flags Korean text when the preamble lacks Korean support", () => {
  const plain = new Map([["main.tex", "\\documentclass{article}\n\\begin{document}\n\\end{document}"]]);
  const withKotex = new Map([["main.tex", "\\documentclass{article}\n\\usepackage{kotex}\n\\begin{document}\n\\end{document}"]]);
  assert.equal(planMarkdownWrite(plain, { markdown: "## 서론", path: "intro.tex" }).needsKorean, true);
  assert.equal(planMarkdownWrite(withKotex, { markdown: "## 서론", path: "intro.tex" }).needsKorean, false);
  assert.equal(planMarkdownWrite(plain, { markdown: "## Intro", path: "intro.tex" }).needsKorean, false);
});
