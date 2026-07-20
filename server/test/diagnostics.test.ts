import assert from "node:assert/strict";
import test from "node:test";

import {
  AdapterDiagnosticSeverity,
  DiagnosticState,
  parseDiagnosticLine,
} from "../src/diagnostics.js";

test("diagnostic paths become file URIs and TeX lines become zero based", () => {
  const parsed = parseDiagnosticLine(
    "error: relative/file.tex:12: missing brace",
    "/workspace/main.tex",
  );
  assert.ok(parsed);
  assert.equal(parsed.uri, "file:///workspace/relative/file.tex");
  assert.equal(parsed.diagnostic.severity, AdapterDiagnosticSeverity.Error);
  assert.deepEqual(parsed.diagnostic.range, {
    start: { line: 11, character: 0 },
    end: { line: 11, character: 1 },
  });
});

test("state handles append-lines, truncation, flush, and stale URI clearing", () => {
  const state = new DiagnosticState({ rootPath: "/workspace/main.tex" });
  state.appendLines("out", [
    "error: main.tex:2: bad",
    "warning: main.tex:3: Overfull \\hbox",
    "warning: chapter.tex:4: caution",
  ]);
  state.appendLines("log", ["TeX log line"]);
  const first = state.flush();
  assert.equal(first.byUri.size, 2);
  assert.equal(first.urisToClear.length, 0);
  assert.equal(first.logLines[0], "TeX log line");
  assert.equal(first.unparsedLines.length, 0);

  state.truncateLines("out", 1);
  const second = state.flush();
  assert.equal(second.byUri.size, 1);
  assert.deepEqual(second.urisToClear, ["file:///workspace/chapter.tex"]);
});

test("box warnings are filtered by default and can be enabled", () => {
  const hidden = new DiagnosticState({ rootPath: "/workspace/main.tex" });
  hidden.appendLines("out", ["warning: main.tex:1: Underfull \\hbox"]);
  assert.equal(hidden.flush().diagnostics.length, 0);

  const shown = new DiagnosticState({
    rootPath: "/workspace/main.tex",
    showBoxWarnings: true,
  });
  shown.appendLines("out", ["warning: main.tex:1: Underfull \\hbox"]);
  const result = shown.flush();
  assert.equal(result.diagnostics.length, 1);
  assert.equal(
    result.diagnostics[0]?.diagnostic.severity,
    AdapterDiagnosticSeverity.Warning,
  );
});

test("unparseable output is retained as log text, not a fake location", () => {
  const state = new DiagnosticState({ rootPath: "/workspace/main.tex" });
  state.appendLines("out", ["This is ordinary TeX output"]);
  const result = state.flush();
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.unparsedLines, ["This is ordinary TeX output"]);
  assert.deepEqual(result.logLines, ["This is ordinary TeX output"]);
});

test("flush logs only new output and respects rollback", () => {
  const state = new DiagnosticState({ rootPath: "/workspace/main.tex" });
  state.appendLines("log", ["engine start"]);
  state.appendLines("out", ["ordinary output"]);
  assert.deepEqual(state.flush().logLines, ["engine start", "ordinary output"]);
  assert.deepEqual(state.flush().logLines, []);

  state.appendLines("log", ["next step"]);
  state.appendLines("out", ["warning: main.tex:2: caution"]);
  assert.deepEqual(state.flush().logLines, ["next step"]);

  state.truncateLines("out", 0);
  state.appendLines("out", ["ordinary output"]);
  assert.deepEqual(state.flush().logLines, ["ordinary output"]);
});

test("legacy partial appends are logged only for their new suffix", () => {
  const state = new DiagnosticState({ rootPath: "/workspace/main.tex" });
  state.append("out", "foo");
  assert.deepEqual(state.flush().logLines, ["foo"]);
  state.append("out", "bar\n");
  assert.deepEqual(state.flush().logLines, ["bar"]);
});

test("holds an incomplete diagnostic prefix across flushes", () => {
  const state = new DiagnosticState({ rootPath: "/workspace/main.tex" });
  state.append("out", "error: main.tex:12");
  const prefix = state.flush();
  assert.deepEqual(prefix.diagnostics, []);
  assert.deepEqual(prefix.logLines, []);

  state.append("out", ": missing brace\n");
  const completed = state.flush();
  assert.equal(completed.diagnostics.length, 1);
  assert.equal(completed.diagnostics[0]?.diagnostic.message, "missing brace");
  assert.deepEqual(completed.logLines, []);
  assert.deepEqual(completed.unparsedLines, []);
});

test("holds a diagnostic prefix with an empty message until its remainder arrives", () => {
  const state = new DiagnosticState({ rootPath: "/workspace/main.tex" });
  state.append("out", "warning: main.tex:4: ");
  assert.deepEqual(state.flush().logLines, []);

  state.append("out", "unused label\n");
  const result = state.flush();
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.diagnostic.message, "unused label");
  assert.deepEqual(result.logLines, []);
});
