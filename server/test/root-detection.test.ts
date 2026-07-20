import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectRoot,
  detectRootSync,
  parseRootMagicComment,
} from "../src/root-detection.js";

const fixtureWorkspace = process.platform === "win32" ? "C:\\workspace" : "/workspace";

test("parses TEX and TeXpresso magic comments with TEX precedence", () => {
  const parsed = parseRootMagicComment(
    "% !TeXpresso root = ../texpresso.tex\n% !TEX root = main file.tex\n",
  );
  assert.deepEqual(parsed, {
    path: "main file.tex",
    kind: "tex",
    line: 1,
  });
});

test("root priority is configured, magic, then current document", async () => {
  const workspace =
    process.platform === "win32"
      ? "C:\\tmp\\texpresso-root-test"
      : "/tmp/texpresso-root-test";
  const document = path.join(workspace, "chapters", "one.tex");
  const configured = await detectRoot({
    documentPath: document,
    documentText: "% !TEX root = magic.tex",
    configuredRoot: "configured.tex",
    workspaceFolders: [workspace],
  });
  assert.deepEqual(configured, {
    found: true,
    rootPath: path.join(workspace, "configured.tex"),
    source: "configured",
  });

  const magic = detectRootSync({
    documentPath: document,
    documentText: "% !TEX root = ../main.tex",
    workspaceFolders: [workspace],
  });
  assert.deepEqual(magic, {
    found: true,
    rootPath: path.join(workspace, "main.tex"),
    source: "tex-magic",
  });

  const current = detectRootSync({
    documentPath: document,
    documentText: "\\begin{document}\ncontent",
    workspaceFolders: [workspace],
  });
  assert.deepEqual(current, {
    found: true,
    rootPath: document,
    source: "current-document",
  });
});

test("workspace detection only chooses a unique main candidate", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "texpresso-root-"));
  await fs.writeFile(path.join(workspace, "main.tex"), "\\begin{document}\n");
  const result = await detectRoot({
    documentPath: path.join(workspace, "chapter.tex"),
    documentText: "\\section{Chapter}",
    workspaceFolders: [workspace],
  });
  assert.deepEqual(result, {
    found: true,
    rootPath: path.join(workspace, "main.tex"),
    source: "workspace",
  });
  await fs.rm(workspace, { recursive: true, force: true });
});

test("ambiguous workspace candidates produce an actionable reason", () => {
  const result = detectRootSync({
    documentPath: path.join(fixtureWorkspace, "chapter.tex"),
    documentText: "\\section{Chapter}",
    workspaceFolders: [fixtureWorkspace],
    workspaceCandidates: [path.join(fixtureWorkspace, "a.tex"), path.join(fixtureWorkspace, "b.tex")],
  });
  assert.equal(result.found, false);
  if (!result.found) {
    assert.match(result.reason, /multiple possible root/iu);
  }
});

test("workspace candidates are requested lazily after higher-priority rules", () => {
  let calls = 0;
  const provider = (): string[] => {
    calls += 1;
    return [path.join(fixtureWorkspace, "main.tex")];
  };
  const current = detectRootSync({
    documentPath: path.join(fixtureWorkspace, "current.tex"),
    documentText: "\\begin{document}\n",
    workspaceFolders: [fixtureWorkspace],
    workspaceCandidatesProvider: provider,
  });
  assert.equal(current.found, true);
  assert.equal(calls, 0);

  const child = detectRootSync({
    documentPath: path.join(fixtureWorkspace, "chapter.tex"),
    documentText: "\\section{Chapter}",
    workspaceFolders: [fixtureWorkspace],
    workspaceCandidatesProvider: provider,
  });
  assert.deepEqual(child, {
    found: true,
    rootPath: path.join(fixtureWorkspace, "main.tex"),
    source: "workspace",
  });
  assert.equal(calls, 1);
});
