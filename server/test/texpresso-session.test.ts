import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import type { Diagnostic } from "vscode-languageserver-types";

import { encodeMessage, type TeXpressoMessage } from "../src/protocol.js";
import {
  TexpressoSession,
  type ProcessFactory,
  type TexpressoProcess,
} from "../src/texpresso-session.js";

class CaptureWritable extends Writable {
  readonly chunks: string[] = [];
  private readonly failWrites: boolean;

  constructor(backpressured = false, failWrites = false) {
    super({
      decodeStrings: false,
      highWaterMark: backpressured ? 1 : 16 * 1024,
    });
    this.failWrites = failWrites;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(
      typeof chunk === "string" ? chunk : chunk.toString("utf8"),
    );
    setImmediate(() =>
      this.failWrites
        ? callback(new Error("synthetic pipe failure"))
        : callback(),
    );
  }

  clear(): void {
    this.chunks.length = 0;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

let nextPid = 10_000;

class FakeProcess extends EventEmitter implements TexpressoProcess {
  readonly stdin: CaptureWritable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  private readonly closeOnKill: boolean;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(
    backpressured = false,
    closeOnKill = true,
    autoSpawn = true,
    failWrites = false,
  ) {
    super();
    this.closeOnKill = closeOnKill;
    this.pid = autoSpawn ? nextPid++ : undefined;
    this.stdin = new CaptureWritable(backpressured, failWrites);
    if (autoSpawn) {
      queueMicrotask(() => this.emit("spawn"));
    }
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.killed = true;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    if (this.closeOnKill) {
      queueMicrotask(() => this.close());
    }
    return true;
  }

  close(): void {
    this.emit("exit", this.exitCode, this.signalCode);
    this.emit("close", this.exitCode, this.signalCode);
  }

  emitMessage(message: TeXpressoMessage): void {
    this.stdout.write(encodeMessage(message));
  }

  fail(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

function decodedCommands(child: FakeProcess): unknown[][] {
  return child.stdin.text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown[]);
}

function commandsNamed(child: FakeProcess, name: string): unknown[][] {
  return decodedCommands(child).filter((message) => message[0] === name);
}

async function settle(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`operation timed out after ${ms}ms`)),
      ms,
    );
    timer.unref();
  });
}

test("session writes exactly one NDJSON line per command and resumes after drain", async () => {
  const child = new FakeProcess(true);
  const session = new TexpressoSession(
    "/workspace/main.tex",
    {},
    { publishDiagnostics: () => undefined },
    () => child,
  );
  await session.start();

  await Promise.race([
    Promise.all([session.nextPage(), session.previousPage(), session.rescan()]),
    timeout(1_000),
  ]);
  await settle();

  assert.equal(
    child.stdin.text,
    [
      encodeMessage(["next-page"]),
      encodeMessage(["previous-page"]),
      encodeMessage(["rescan"]),
    ].join(""),
  );
  assert.deepEqual(decodedCommands(child), [
    ["next-page"],
    ["previous-page"],
    ["rescan"],
  ]);
  await session.stop();
});

test("spawns with an argument array for paths and configured options", async () => {
  const root = "/workspace/paper with spaces/main.tex";
  const child = new FakeProcess();
  let invocation:
    | {
        command: string;
        args: readonly string[];
        shell: false | undefined;
        cwd: string | undefined;
      }
    | undefined;
  const session = new TexpressoSession(
    root,
    {
      command: "/opt/TeXpresso bin/texpresso",
      distribution: "tectonic",
      includePaths: ["includes with spaces", "/shared/tex"],
      extraArgs: ["--jobname", "paper draft"],
    },
    { publishDiagnostics: () => undefined },
    (command, args, options) => {
      invocation = {
        command,
        args: [...args],
        shell: options.shell,
        cwd: options.cwd,
      };
      return child;
    },
  );
  await session.start();
  assert.deepEqual(invocation, {
    command: "/opt/TeXpresso bin/texpresso",
    args: [
      "-json",
      "-lines",
      "-tectonic",
      "-I",
      "includes with spaces",
      "-I",
      "/shared/tex",
      "--jobname",
      "paper draft",
      root,
    ],
    shell: false,
    cwd: "/workspace/paper with spaces",
  });
  await session.stop();
});

test("rejects a pipe write failure and terminates the child", async () => {
  const child = new FakeProcess(false, true, true, true);
  const session = new TexpressoSession(
    "/workspace/main.tex",
    {},
    { publishDiagnostics: () => undefined },
    () => child,
  );
  await session.start();
  await assert.rejects(session.nextPage(), /synthetic pipe failure/u);
  await settle();
  assert.equal(child.killed, true);
  assert.equal(session.running, false);
  await session.stop();
});

test("treats an already-closed stdin as a recoverable process failure", async () => {
  const child = new FakeProcess();
  child.stdin.end();
  const session = new TexpressoSession(
    "/workspace/main.tex",
    { stopTimeoutMs: 1 },
    { publishDiagnostics: () => undefined },
    () => child,
  );
  await session.start();
  await assert.rejects(session.nextPage(), /stdin is closed/u);
  await settle();
  assert.equal(session.running, false);
  await session.stop();
});

test("synchronizes open editor buffers before input registration and refreshes them", async () => {
  const root = "/workspace/project/main.tex";
  const chapter = "/workspace/project/chapter.tex";
  const child = new FakeProcess();
  const liveDocuments = new Map<string, string>();
  const session = new TexpressoSession(
    root,
    {},
    {
      publishDiagnostics: () => undefined,
      getOpenDocument: (filePath) => liveDocuments.get(filePath),
    },
    () => child,
  );
  await session.start();

  await session.openDocument(chapter, "cached but stale");
  assert.equal(session.ownsPath(chapter), false);
  assert.equal(session.tracksPath(chapter), true);
  assert.deepEqual(commandsNamed(child, "open"), [
    ["open", chapter, "cached but stale"],
  ]);
  assert.deepEqual(
    session.documentsSnapshot.find(({ path }) => path === chapter),
    {
      path: chapter,
      text: "cached but stale",
      editorOpen: true,
      vfsPaths: [chapter],
      referenced: false,
    },
  );

  liveDocuments.set(chapter, "fresh unsaved text");
  child.emitMessage(["input-file", 1, "chapter.tex"]);
  await settle();
  assert.deepEqual(commandsNamed(child, "open").at(-1), [
    "open",
    chapter,
    "fresh unsaved text",
  ]);
  assert.equal(
    session.documentsSnapshot.find(({ path }) => path === chapter)?.text,
    "fresh unsaved text",
  );

  child.emitMessage(["input-file", 1, "replacement.tex"]);
  await settle();
  liveDocuments.set(chapter, "edited after rollback");
  await session.changeDocument(chapter, { text: "edited after rollback" });
  child.stdin.clear();
  child.emitMessage(["input-file", 1, "chapter.tex"]);
  await settle();
  assert.deepEqual(commandsNamed(child, "open").at(-1), [
    "open",
    chapter,
    "edited after rollback",
  ]);

  child.emitMessage(["input-file", 1, "replacement.tex"]);
  await settle();
  liveDocuments.delete(chapter);
  await session.closeDocument(chapter);
  assert.equal(session.tracksPath(chapter), false);
  assert.equal(
    session.documentsSnapshot.some(({ path }) => path === chapter),
    false,
  );
  child.stdin.clear();
  const opensAfterClose = commandsNamed(child, "open").length;
  child.emitMessage(["input-file", 1, "chapter.tex"]);
  await settle();
  assert.equal(commandsNamed(child, "open").length, opensAfterClose);
  await session.stop();
});

test("lookup-file fulfills a promised path from an unsaved editor buffer", async () => {
  const root = "/workspace/project/main.tex";
  const generated = "/workspace/project/generated.tex";
  const child = new FakeProcess();
  const session = new TexpressoSession(
    root,
    {},
    {
      publishDiagnostics: () => undefined,
      getOpenDocument: (filePath) =>
        filePath === generated ? "unsaved generated contents" : undefined,
    },
    () => child,
  );
  await session.start();

  child.emitMessage(["lookup-file", "read", "promised", "generated.tex"]);
  await settle();
  assert.deepEqual(commandsNamed(child, "open"), [
    ["open", generated, "unsaved generated contents"],
  ]);
  assert.equal(session.ownsPath(generated), true);
  await session.stop();
});

test("queues start while stopping and ignores a late close from the previous child", async () => {
  const children: FakeProcess[] = [];
  const session = new TexpressoSession(
    "/workspace/main.tex",
    { stopTimeoutMs: 1 },
    { publishDiagnostics: () => undefined },
    () => {
      const child = new FakeProcess(false, false);
      children.push(child);
      return child;
    },
  );

  await session.start();
  const first = children[0];
  assert.ok(first);
  const stopping = session.stop();
  const starting = session.start();
  await Promise.race([Promise.all([stopping, starting]), timeout(1_000)]);

  const second = children[1];
  assert.ok(second);
  assert.equal(session.process, second);
  assert.equal(session.running, true);

  first.close();
  await settle();
  assert.equal(session.process, second);
  assert.equal(session.running, true);

  await session.stop();
});

test("a start requested while an in-flight start is stopping waits for a fresh child", async () => {
  const children: FakeProcess[] = [];
  const session = new TexpressoSession(
    "/workspace/main.tex",
    { stopTimeoutMs: 1 },
    { publishDiagnostics: () => undefined },
    () => {
      const child =
        children.length === 0
          ? new FakeProcess(false, false, false)
          : new FakeProcess();
      children.push(child);
      return child;
    },
  );

  const initialStart = session.start().then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
  const first = children[0];
  assert.ok(first);
  const stopping = session.stop();
  const queuedStart = session.start();
  assert.equal(await initialStart, "rejected");
  await Promise.race([Promise.all([stopping, queuedStart]), timeout(1_000)]);

  assert.equal(children.length, 2);
  assert.equal(session.running, true);
  assert.equal(session.process, children[1]);
  await session.stop();
});

test("coalesces concurrent restarts without orphaning a child", async () => {
  const children: FakeProcess[] = [];
  const session = new TexpressoSession(
    "/workspace/main.tex",
    {},
    { publishDiagnostics: () => undefined },
    () => {
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
  );
  await session.start();
  await Promise.race([
    Promise.all([session.restart(), session.restart()]),
    timeout(1_000),
  ]);
  assert.equal(children.length, 2);
  assert.equal(session.process, children[1]);
  assert.equal(session.running, true);
  await session.stop();
});

test("terminal shutdown prevents an in-flight restart from spawning a replacement", async () => {
  const children: FakeProcess[] = [];
  const session = new TexpressoSession(
    "/workspace/main.tex",
    {},
    { publishDiagnostics: () => undefined },
    () => {
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
  );
  await session.start();

  const restarting = session.restart();
  await session.shutdown();
  await assert.rejects(restarting, /shut down/u);

  assert.equal(children.length, 1);
  assert.equal(session.process, undefined);
  assert.equal(session.running, false);
  await assert.rejects(session.start(), /shut down/u);
});

test("serializes reconciles so input rollback cannot reopen a stale path alias", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "texpresso-session-"));
  const root = path.join(workspace, "main.tex");
  const realPath = path.join(workspace, "chapter.tex");
  const firstAlias = path.join(workspace, "chapter-first.tex");
  const staleAlias = path.join(workspace, "chapter-stale.tex");
  const currentAlias = path.join(workspace, "chapter-current.tex");
  await fs.writeFile(realPath, "chapter");
  await Promise.all([
    fs.symlink(realPath, firstAlias),
    fs.symlink(realPath, staleAlias),
    fs.symlink(realPath, currentAlias),
  ]);

  const child = new FakeProcess();
  const session = new TexpressoSession(
    root,
    {},
    { publishDiagnostics: () => undefined },
    () => child,
  );
  try {
    await session.start();
    await session.openDocument(realPath, "unsaved chapter");
    child.emitMessage(["input-file", 1, path.basename(firstAlias)]);
    await settle();
    child.stdin.clear();

    child.emitMessage(["input-file", 1, path.basename(staleAlias)]);
    child.emitMessage(["input-file", 1, path.basename(currentAlias)]);
    await settle();

    assert.equal(
      commandsNamed(child, "open").some((message) => message[1] === staleAlias),
      false,
    );
    assert.deepEqual(
      new Set(
        session.documentsSnapshot.find(({ path: documentPath }) => documentPath === realPath)
          ?.vfsPaths,
      ),
      new Set([realPath, currentAlias]),
    );
  } finally {
    await session.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("input-file rollback drops higher indexes and reset-sync rebuilds the current VFS", async () => {
  const root = "/workspace/project/main.tex";
  const openDocuments = new Map<string, string>([
    [root, "root text"],
    ["/workspace/project/a.tex", "unsaved a"],
    ["/workspace/project/b.tex", "unsaved b"],
    ["/workspace/project/c.tex", "unsaved c"],
  ]);
  const children: FakeProcess[] = [];
  const factory: ProcessFactory = () => {
    const child = new FakeProcess();
    children.push(child);
    return child;
  };
  const session = new TexpressoSession(
    root,
    {},
    {
      publishDiagnostics: () => undefined,
      getOpenDocument: (filePath) => openDocuments.get(filePath),
    },
    factory,
  );
  await session.start();
  let child = children[0];
  assert.ok(child);
  await session.openDocument(root, openDocuments.get(root) ?? "");

  child.emitMessage(["input-file", 1, "a.tex"]);
  child.emitMessage(["input-file", 2, "b.tex"]);
  await settle();
  assert.deepEqual(
    session.trackedFiles.map(({ index, relativePath }) => ({
      index,
      relativePath,
    })),
    [
      { index: 1, relativePath: "a.tex" },
      { index: 2, relativePath: "b.tex" },
    ],
  );

  child.stdin.clear();
  await session.closeDocument("/workspace/project/b.tex");
  assert.equal(
    commandsNamed(child, "close").length,
    0,
    "a closed buffer stays cached while its input-file record references it",
  );

  child.stdin.clear();
  child.emitMessage(["input-file", 1, "c.tex"]);
  await settle();
  assert.deepEqual(
    session.trackedFiles.map(({ index, relativePath }) => ({
      index,
      relativePath,
    })),
    [{ index: 1, relativePath: "c.tex" }],
  );
  assert.deepEqual(
    new Set(commandsNamed(child, "close").map((message) => message[1])),
    new Set(["/workspace/project/b.tex"]),
  );
  assert.deepEqual(commandsNamed(child, "open"), [
    ["open", "/workspace/project/c.tex", "unsaved c"],
  ]);

  child.stdin.clear();
  await session.closeDocument("/workspace/project/c.tex");
  assert.equal(commandsNamed(child, "close").length, 0);
  child.emitMessage(["reset-sync"]);
  await settle();
  assert.deepEqual(
    new Set(
      commandsNamed(child, "open").map((message) =>
        JSON.stringify(message),
      ),
    ),
    new Set([
      JSON.stringify(["open", root, "root text"]),
      JSON.stringify(["open", "/workspace/project/a.tex", "unsaved a"]),
      JSON.stringify(["open", "/workspace/project/c.tex", "unsaved c"]),
    ]),
  );
  assert.equal(commandsNamed(child, "close").length, 0);

  await session.restart();
  await settle();
  child = children[1];
  assert.ok(child);
  assert.deepEqual(
    new Set(
      commandsNamed(child, "open").map((message) => JSON.stringify(message)),
    ),
    new Set([
      JSON.stringify(["open", root, "root text"]),
      JSON.stringify(["open", "/workspace/project/a.tex", "unsaved a"]),
      JSON.stringify(["open", "/workspace/project/c.tex", "unsaved c"]),
    ]),
  );
  await session.stop();
});

test("merges chunked stderr diagnostics with protocol diagnostics and clears them on edit", async () => {
  const root = "/workspace/main.tex";
  const child = new FakeProcess();
  const published: Array<{ uri: string; diagnostics: Diagnostic[] }> = [];
  const session = new TexpressoSession(
    root,
    {},
    {
      publishDiagnostics: (uri, diagnostics) => {
        published.push({ uri, diagnostics });
      },
    },
    () => child,
  );
  await session.start();
  await session.openDocument(root, "root text");

  child.emitMessage(["append-lines", "out", "error: main.tex:3: protocol error"]);
  child.emitMessage(["flush"]);
  child.stderr.write(Buffer.from("Warn"));
  child.stderr.write(Buffer.from("ing: /workspace/main.tex:5: engine warning\n"));
  await settle();

  assert.deepEqual(
    published.at(-1)?.diagnostics.map((diagnostic) => ({
      line: diagnostic.range.start.line,
      message: diagnostic.message,
    })),
    [
      { line: 2, message: "protocol error" },
      { line: 4, message: "engine warning" },
    ],
  );

  await session.changeDocument(root, { text: "updated root" });
  assert.deepEqual(
    published.at(-1)?.diagnostics.map((diagnostic) => diagnostic.message),
    ["protocol error"],
  );
  await session.stop();
});

test("nonzero child exit clears diagnostics and a new process rebuilds cached buffers", async () => {
  const root = "/workspace/main.tex";
  const children: FakeProcess[] = [];
  const published: Array<{ uri: string; diagnostics: Diagnostic[] }> = [];
  const exits: Array<Error | undefined> = [];
  const factory: ProcessFactory = () => {
    const child = new FakeProcess();
    children.push(child);
    return child;
  };
  const session = new TexpressoSession(
    root,
    {},
    {
      publishDiagnostics: (uri, diagnostics) => {
        published.push({ uri, diagnostics });
      },
      exited: (error) => exits.push(error),
    },
    factory,
  );

  await session.start();
  await session.openDocument(root, "unsaved root");
  const first = children[0];
  assert.ok(first);
  first.emitMessage(["append-lines", "out", "error: main.tex:3: broken"]);
  first.emitMessage(["flush"]);
  await settle();
  assert.equal(published.at(-1)?.diagnostics.length, 1);
  assert.equal(published.at(-1)?.diagnostics[0]?.range.start.line, 2);

  first.fail(23);
  await settle();
  assert.equal(session.running, false);
  assert.match(exits[0]?.message ?? "", /code 23/u);
  assert.deepEqual(published.at(-1), {
    uri: "file:///workspace/main.tex",
    diagnostics: [],
  });

  await session.start();
  await settle();
  const second = children[1];
  assert.ok(second);
  assert.deepEqual(commandsNamed(second, "open"), [
    ["open", root, "unsaved root"],
  ]);
  await session.stop();
});
