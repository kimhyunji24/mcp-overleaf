import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findHeading, findMainFile, parseOutline, sectionRange, stripComment } from "./latex.js";
import { safeJoin } from "./project.js";

const files = new Map<string, string>([
  [
    "main.tex",
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "Intro text. 50\\% done % a comment \\section{Fake}",
      "\\input{sections/method}",
      "\\section*{Related {Work}}",
      "Related.",
      "",
      "\\end{document}",
    ].join("\n"),
  ],
  ["sections/method.tex", "\\section{Method}\n\\subsection[short]{Model Details}\nText.\n\\subsection{Training}\nMore."],
  ["unused.tex", "\\section{Orphan}"],
]);

test("stripComment keeps escaped percent signs", () => {
  assert.equal(stripComment("50\\% done % comment"), "50\\% done ");
  assert.equal(stripComment("a \\\\% comment"), "a \\\\");
  assert.equal(stripComment("no comment"), "no comment");
});

test("findMainFile prefers main.tex with \\documentclass", () => {
  assert.equal(findMainFile(files), "main.tex");
});

test("parseOutline follows \\input in document order", () => {
  const titles = parseOutline(files).map((h) => `${h.command}:${h.title}`);
  assert.deepEqual(titles, [
    "section:Introduction",
    "section:Method",
    "subsection:Model Details",
    "subsection:Training",
    "section:Related {Work}",
    "section:Orphan",
  ]);
});

test("sectionRange stops at next same-level heading and \\end{document}", () => {
  const headings = parseOutline(files);
  const method = findHeading(headings, "model details");
  assert.deepEqual(sectionRange(headings, method, files.get(method.file)!), { start: 2, end: 3 });
  const related = findHeading(headings, "Related");
  assert.deepEqual(sectionRange(headings, related, files.get("main.tex")!), { start: 6, end: 7 });
});

test("findHeading reports ambiguity", () => {
  assert.throws(() => findHeading(parseOutline(files), "i"), /several sections/);
});

test("safeJoin rejects traversal and .git", () => {
  const root = path.resolve("/tmp/project");
  assert.equal(safeJoin(root, "a/b.tex"), path.join(root, "a", "b.tex"));
  assert.throws(() => safeJoin(root, "../x"));
  assert.throws(() => safeJoin(root, "a/../../x"));
  assert.throws(() => safeJoin(root, ".git/config"));
  assert.throws(() => safeJoin(root, "C:/Windows/x"));
});
