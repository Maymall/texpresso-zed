import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { URI } from "vscode-uri";

interface FakeEvent {
  readonly type: string;
  readonly message?: readonly unknown[];
  readonly args?: readonly string[];
  readonly signal?: string;
  readonly code?: number;
}

const FAKE_TEXPRESSO = `
const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(__dirname, "events.ndjson");
const rootPath = process.argv[process.argv.length - 1];
let inputSent = false;
let resetSent = false;
function record(event) {
  fs.appendFileSync(eventsPath, JSON.stringify(event) + "\\n");
}
function output(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
process.on("SIGTERM", () => {
  record({ type: "signal", signal: "SIGTERM" });
  process.exit(0);
});
process.on("exit", (code) => {
  record({ type: "exit", code });
});
record({ type: "start", args: process.argv.slice(2) });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) {
      record({ type: "blank" });
      continue;
    }
    const message = JSON.parse(line);
    record({ type: "command", message });
    const name = message[0];
    if (name === "open" && message[1] === rootPath && !inputSent) {
      inputSent = true;
      const frame = JSON.stringify(["input-file", 1, "child.tex"]) + "\\n";
      process.stdout.write(frame.slice(0, 5));
      setTimeout(() => {
        process.stdout.write(frame.slice(5));
        process.stdout.write(JSON.stringify(["append-lines", "out", "ordinary TeX output"]) + "\\n" + JSON.stringify(["flush"]) + "\\n");
        process.stderr.write("Err");
        process.stderr.write("or: " + path.join(__dirname, "child.tex") + ":2: fake error\\n");
      }, 5);
    }
    if (name === "open" && typeof message[1] === "string" && message[1].endsWith("child.tex") && !resetSent) {
      resetSent = true;
      setTimeout(() => output(["reset-sync"]), 5);
    }
    if (name === "rescan") {
      setTimeout(() => process.exit(23), 5);
    }
  }
});
record({ type: "ready" });
`;

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function fakeEvents(filePath: string): Promise<FakeEvent[]> {
  try {
    const text = await readFile(filePath, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeEvent);
  } catch {
    return [];
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await delay(15);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function commandMessages(events: readonly FakeEvent[]): readonly unknown[][] {
  return events
    .filter((event) => event.type === "command" && event.message)
    .map((event) => [...(event.message ?? [])]);
}

function countCommand(
  events: readonly FakeEvent[],
  name: string,
  pathValue?: string,
): number {
  return commandMessages(events).filter(
    (message) =>
      message[0] === name &&
      (pathValue === undefined || message[1] === pathValue),
  ).length;
}

function sessionPath(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

test("starts the adapter over stdio and synchronizes a fake TeXpresso process end to end", async () => {
  const workspace = sessionPath(
    await realpath(await mkdtemp(path.join(tmpdir(), "texpresso zed e2e-"))),
  );
  const mainPath = path.join(workspace, "main.tex");
  const childPath = path.join(workspace, "child.tex");
  const fakePath = path.join(workspace, "fake-texpresso.cjs");
  const eventsPath = path.join(workspace, "events.ndjson");
  const mainText = "\\documentclass{article}\n\\begin{document}\nmain\n";
  const childText = "alpha😀\nchild\n";
  await writeFile(mainPath, mainText);
  await writeFile(childPath, "saved child\n");
  await writeFile(fakePath, FAKE_TEXPRESSO, "utf8");

  const sourceAdapterPath = path.resolve("src/server.ts");
  const configuredAdapterPath = process.env.TEXPRESSO_LSP_ADAPTER;
  const adapterArguments = configuredAdapterPath
    ? [path.resolve(configuredAdapterPath)]
    : ["--import", "tsx", sourceAdapterPath];
  const adapter: ChildProcess = spawn(
    process.execPath,
    adapterArguments,
    { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr: Buffer[] = [];
  adapter.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const reader = new StreamMessageReader(adapter.stdout!);
  const writer = new StreamMessageWriter(adapter.stdin!);
  const connection: MessageConnection = createMessageConnection(reader, writer);
  const diagnostics: Array<{
    uri: string;
    diagnostics: readonly { message: string; range: { start: { line: number } } }[];
  }> = [];
  const registrations: Array<{
    method?: string;
    registerOptions?: unknown;
  }> = [];
  connection.onRequest("client/registerCapability", (params: unknown) => {
    const value = params as {
      registrations?: Array<{ method?: string; registerOptions?: unknown }>;
    };
    registrations.push(...(value.registrations ?? []));
    return null;
  });
  connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
    const value = params as {
      uri: string;
      diagnostics: readonly {
        message: string;
        range: { start: { line: number } };
      }[];
    };
    diagnostics.push(value);
  });
  connection.listen();

  const mainUri = URI.file(mainPath).toString();
  const childUri = URI.file(childPath).toString();
  try {
    const initialized = await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: URI.file(workspace).toString(),
      workspaceFolders: [{ uri: URI.file(workspace).toString(), name: "e2e" }],
      capabilities: {
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceFolders: true,
        },
      },
      initializationOptions: {
        texpressoCommand: process.execPath,
        extraArgs: [fakePath],
        autoStart: true,
      },
    });
    const capabilities = initialized as {
      capabilities: {
        positionEncoding?: string;
        workspace?: {
          fileOperations?: {
            didRename?: unknown;
            didDelete?: unknown;
          };
        };
      };
    };
    assert.equal(capabilities.capabilities.positionEncoding, "utf-16");
    assert.ok(capabilities.capabilities.workspace?.fileOperations?.didRename);
    assert.ok(capabilities.capabilities.workspace?.fileOperations?.didDelete);
    connection.sendNotification("initialized", {});

    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: mainUri,
        languageId: "latex",
        version: 1,
        text: mainText,
      },
    });
    const afterRootOpen = await waitFor(
      () => fakeEvents(eventsPath),
      (events) => countCommand(events, "open", mainPath) >= 1,
      "root open command",
    );
    assert.deepEqual(
      afterRootOpen.find((event) => event.type === "start")?.args,
      ["-json", "-lines", mainPath],
    );
    await waitFor(
      () => diagnostics,
      (items) =>
        items.some(
          (item) =>
            item.uri === childUri &&
            item.diagnostics.some(
              (diagnostic) =>
                diagnostic.message === "fake error" &&
                diagnostic.range.start.line === 1,
            ),
        ),
      "fake TeXpresso diagnostic",
    );

    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: childUri,
        languageId: "latex",
        version: 1,
        text: childText,
      },
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) => countCommand(events, "open", childPath) >= 1,
      "child open command",
    );
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        countCommand(events, "open", mainPath) >= 2 &&
        countCommand(events, "open", childPath) >= 2,
      "reset-sync VFS rebuild",
    );

    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: childUri, version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 5 },
            end: { line: 0, character: 7 },
          },
          text: "X",
        },
      ],
    });
    const afterChange = await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        commandMessages(events).some(
          (message) =>
            JSON.stringify(message) ===
            JSON.stringify([
              "change-range",
              childPath,
              0,
              5,
              0,
              7,
              "X",
            ]),
        ),
      "UTF-16 child change-range",
    );
    assert.equal(afterChange.some((event) => event.type === "blank"), false);

    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.forwardSync",
      arguments: [{ uri: childUri, line: 6 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        commandMessages(events).some(
          (message) =>
            JSON.stringify(message) ===
            JSON.stringify(["synctex-forward", childPath, 7]),
        ),
      "forward SyncTeX command",
    );

    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.rescan",
      arguments: [{ uri: mainUri, line: 0 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) => events.some((event) => event.type === "command" && event.message?.[0] === "rescan"),
      "rescan command",
    );
    await waitFor(
      () => diagnostics,
      (items) =>
        items.some((item) => item.uri === childUri && item.diagnostics.length === 0) &&
        items.some(
          (item) =>
            item.uri === mainUri &&
            item.diagnostics.some((diagnostic) => /stopped unexpectedly/u.test(diagnostic.message)),
        ),
      "diagnostic cleanup after abnormal process exit",
    );
    assert.equal(
      adapter.exitCode,
      null,
      "the LSP adapter must survive an abnormal TeXpresso exit",
    );

    // Two changes are deliberately queued immediately after the child exits.
    // Recovery may apply them incrementally or replace the buffer, but it must
    // never replay a range after opening the already-updated full snapshot.
    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: childUri, version: 3 },
      contentChanges: [
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 5 },
          },
          text: "first",
        },
      ],
    });
    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: childUri, version: 4 },
      contentChanges: [
        {
          range: {
            start: { line: 1, character: 5 },
            end: { line: 1, character: 5 },
          },
          text: "!",
        },
      ],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "start").length >= 2 &&
        countCommand(events, "open", mainPath) >= 4 &&
        countCommand(events, "open", childPath) >= 4 &&
        commandMessages(events).some(
          (message) =>
            message[0] === "open" &&
            message[1] === childPath &&
            message[2] === "alphaX\nfirst!\n",
        ),
      "fresh process and rebuilt VFS after abnormal exit",
    );
    const recoveredEvents = await fakeEvents(eventsPath);
    const recoveredCommands = commandMessages(recoveredEvents);
    const finalSnapshotIndex = recoveredCommands.findLastIndex(
      (message) =>
        message[0] === "open" &&
        message[1] === childPath &&
        message[2] === "alphaX\nfirst!\n",
    );
    assert.notEqual(finalSnapshotIndex, -1);
    assert.equal(
      recoveredCommands.slice(finalSnapshotIndex + 1).some(
        (message) =>
          message[0] === "change-range" &&
          (message[6] === "first" || message[6] === "!"),
      ),
      false,
      "historical recovery ranges must not be replayed after a full snapshot",
    );

    const exitsBeforeConfiguration = recoveredEvents.filter(
      (event) => event.type === "exit",
    ).length;
    const startsBeforeConfiguration = recoveredEvents.filter(
      (event) => event.type === "start",
    ).length;
    await connection.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        "texpresso-live": {
          texpressoCommand: process.execPath,
          autoStart: true,
          logLevel: "debug",
          extraArgs: [fakePath, "--configuration-restart"],
        },
      },
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "exit").length >=
          exitsBeforeConfiguration + 1 &&
        events.filter((event) => event.type === "start").length ===
          startsBeforeConfiguration + 1 &&
        events.filter((event) => event.type === "ready").length >=
          startsBeforeConfiguration + 1,
      "configuration restart",
    );

    const configuredEvents = await fakeEvents(eventsPath);
    assert.deepEqual(
      configuredEvents.filter((event) => event.type === "start").at(-1)?.args,
      ["--configuration-restart", "-json", "-lines", mainPath],
    );
    const startsBeforeStop = configuredEvents.filter(
      (event) => event.type === "start",
    ).length;
    const exitsBeforeStop = configuredEvents.filter(
      (event) => event.type === "exit",
    ).length;
    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.stop",
      arguments: [{ uri: mainUri, line: 0 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "exit").length >=
        exitsBeforeStop + 1,
      "manual stop",
    );
    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: childUri, version: 5 },
      contentChanges: [
        {
          range: {
            start: { line: 1, character: 6 },
            end: { line: 1, character: 6 },
          },
          text: "?",
        },
      ],
    });
    await delay(200);
    assert.equal(
      (await fakeEvents(eventsPath)).filter((event) => event.type === "start").length,
      startsBeforeStop,
      "editing after Stop must not silently restart TeXpresso",
    );

    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.restart",
      arguments: [{ uri: mainUri, line: 0 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "start").length === startsBeforeStop + 1 &&
        events.filter((event) => event.type === "ready").length >= startsBeforeStop + 1 &&
        commandMessages(events).some(
          (message) =>
            message[0] === "open" &&
            message[1] === childPath &&
            message[2] === "alphaX\nfirst!?\n",
        ),
      "single restart after manual stop",
    );
    await delay(150);
    assert.equal(
      (await fakeEvents(eventsPath)).filter((event) => event.type === "start").length,
      startsBeforeStop + 1,
    );

    const renamedRootPath = path.join(workspace, "renamed-main.tex");
    const exitsBeforeRename = (await fakeEvents(eventsPath)).filter(
      (event) => event.type === "exit",
    ).length;
    await connection.sendNotification("workspace/didRenameFiles", {
      files: [{ oldUri: mainUri, newUri: URI.file(renamedRootPath).toString() }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "exit").length >=
        exitsBeforeRename + 1,
      "root rename cleanup",
    );

    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.restart",
      arguments: [{ uri: mainUri, line: 0 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "start").length ===
        startsBeforeStop + 2 &&
        events.filter((event) => event.type === "ready").length >= startsBeforeStop + 2,
      "restart before watched deletion",
    );
    await waitFor(
      async () => registrations,
      (items) =>
        items.some(
          (registration) =>
            registration.method === "workspace/didChangeWatchedFiles",
        ),
      "dynamic TeX deletion watcher registration",
    );
    const exitsBeforeWatchedDelete = (await fakeEvents(eventsPath)).filter(
      (event) => event.type === "exit",
    ).length;
    await connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: mainUri, type: 3 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "exit").length >=
        exitsBeforeWatchedDelete + 1,
      "watched root deletion cleanup",
    );
    const startsAfterWatchedDelete = (await fakeEvents(eventsPath)).filter(
      (event) => event.type === "start",
    ).length;
    await connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: childUri, type: 2 }],
    });
    await delay(150);
    assert.equal(
      (await fakeEvents(eventsPath)).filter((event) => event.type === "start")
        .length,
      startsAfterWatchedDelete,
      "an unrelated watched change must not revive a deleted root",
    );

    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.restart",
      arguments: [{ uri: mainUri, line: 0 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "start").length ===
        startsBeforeStop + 3 &&
        events.filter((event) => event.type === "ready").length >= startsBeforeStop + 3,
      "final live process before shutdown",
    );

    const exitsBeforeWorkspaceRemoval = (await fakeEvents(eventsPath)).filter(
      (event) => event.type === "exit",
    ).length;
    await connection.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: {
        added: [],
        removed: [{ uri: URI.file(workspace).toString(), name: "e2e" }],
      },
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "exit").length >=
        exitsBeforeWorkspaceRemoval + 1,
      "workspace removal cleanup",
    );
    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.restart",
      arguments: [{ uri: mainUri, line: 0 }],
    });
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "start").length ===
        startsBeforeStop + 4 &&
        events.filter((event) => event.type === "ready").length >= startsBeforeStop + 4,
      "live process before LSP shutdown",
    );

    const exitsBeforeShutdown = (await fakeEvents(eventsPath)).filter(
      (event) => event.type === "exit",
    ).length;
    await connection.sendRequest("shutdown");
    await waitFor(
      () => fakeEvents(eventsPath),
      (events) =>
        events.filter((event) => event.type === "exit").length >=
        exitsBeforeShutdown + 1,
      "child cleanup before LSP exit",
    );
    const adapterExit = once(adapter, "exit");
    connection.sendNotification("exit");
    await waitWithTimeout(
      adapterExit,
      2_000,
      "adapter did not exit after LSP shutdown/exit",
    );
    const afterShutdown = await fakeEvents(eventsPath);
    assert.equal(
      afterShutdown.filter(
        (event) => event.type === "exit",
      ).length >= exitsBeforeShutdown + 1,
      true,
      "LSP shutdown must terminate the live TeXpresso child",
    );
  } finally {
    if (adapter.exitCode === null && !adapter.killed) {
      adapter.kill("SIGTERM");
      await once(adapter, "exit").catch(() => undefined);
    }
    connection.dispose();
    await rm(workspace, { recursive: true, force: true });
    const errorOutput = Buffer.concat(stderr).toString("utf8");
    assert.equal(errorOutput, "", `adapter stderr: ${errorOutput}`);
  }
});
