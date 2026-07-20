import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
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
  readonly root?: string;
  readonly pid?: number;
  readonly args?: readonly string[];
  readonly message?: readonly unknown[];
  readonly signal?: string;
}

const MULTI_ROOT_FAKE_TEXPRESSO = `
const fs = require("node:fs");
const path = require("node:path");

const eventsPath = path.join(__dirname, "events.ndjson");
const root = process.argv.at(-1);
function record(event) {
  fs.appendFileSync(eventsPath, JSON.stringify({ root, ...event }) + "\\n");
}
process.on("SIGTERM", () => {
  record({ type: "signal", signal: "SIGTERM" });
  process.exit(0);
});
process.on("exit", () => record({ type: "exit" }));
record({ type: "start", args: process.argv.slice(2), pid: process.pid });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) record({ type: "command", message: JSON.parse(line) });
  }
});
`;

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMilliseconds = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await delay(15);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readEvents(eventsPath: string): Promise<FakeEvent[]> {
  try {
    const text = await readFile(eventsPath, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeEvent);
  } catch {
    return [];
  }
}

function commandsFor(
  events: readonly FakeEvent[],
  root: string,
): readonly unknown[][] {
  return events
    .filter((event) => event.root === root && event.type === "command")
    .map((event) => [...(event.message ?? [])]);
}

function sessionPath(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

test("isolates independent root sessions through the stdio LSP adapter", async () => {
  const workspace = sessionPath(
    await realpath(await mkdtemp(path.join(tmpdir(), "texpresso multi-root "))),
  );
  const firstRoot = path.join(workspace, "first.tex");
  const secondRoot = path.join(workspace, "second.tex");
  const fakePath = path.join(workspace, "fake-texpresso.cjs");
  const eventsPath = path.join(workspace, "events.ndjson");
  const firstText = "\\documentclass{article}\n\\begin{document}\nfirst\n";
  const secondText = "\\documentclass{article}\n\\begin{document}\nsecond\n";
  await Promise.all([
    writeFile(firstRoot, firstText),
    writeFile(secondRoot, secondText),
    writeFile(fakePath, MULTI_ROOT_FAKE_TEXPRESSO, "utf8"),
  ]);

  const sourceAdapterPath = path.resolve("src/server.ts");
  const configuredAdapterPath = process.env.TEXPRESSO_LSP_ADAPTER;
  const adapterArguments = configuredAdapterPath
    ? [path.resolve(configuredAdapterPath)]
    : ["--import", "tsx", sourceAdapterPath];
  const adapter: ChildProcess = spawn(process.execPath, adapterArguments, {
    cwd: path.resolve("."),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  adapter.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  const reader = new StreamMessageReader(adapter.stdout!);
  const writer = new StreamMessageWriter(adapter.stdin!);
  const connection: MessageConnection = createMessageConnection(reader, writer);
  connection.listen();

  const firstUri = URI.file(firstRoot).toString();
  const secondUri = URI.file(secondRoot).toString();
  try {
    await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: URI.file(workspace).toString(),
      workspaceFolders: [{ uri: URI.file(workspace).toString(), name: "multi-root" }],
      capabilities: {},
      initializationOptions: {
        texpressoCommand: process.execPath,
        extraArgs: [fakePath],
      },
    });
    connection.sendNotification("initialized", {});

    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: firstUri,
        languageId: "latex",
        version: 1,
        text: firstText,
      },
    });
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: secondUri,
        languageId: "latex",
        version: 1,
        text: secondText,
      },
    });

    await waitFor(
      () => readEvents(eventsPath),
      (events) =>
        events.some((event) => event.type === "start" && event.root === firstRoot) &&
        events.some((event) => event.type === "start" && event.root === secondRoot),
      "one fake TeXpresso process per root",
    );
    const afterStart = await readEvents(eventsPath);
    assert.deepEqual(
      afterStart.find((event) => event.type === "start" && event.root === firstRoot)?.args,
      ["-json", "-lines", firstRoot],
    );
    assert.deepEqual(
      afterStart.find((event) => event.type === "start" && event.root === secondRoot)?.args,
      ["-json", "-lines", secondRoot],
    );

    connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: firstUri, version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 5 },
          },
          text: "updated",
        },
      ],
    });
    await waitFor(
      () => readEvents(eventsPath),
      (events) =>
        commandsFor(events, firstRoot).some(
          (message) =>
            JSON.stringify(message) ===
            JSON.stringify(["change-range", firstRoot, 2, 0, 2, 5, "updated"]),
        ),
      "first root change-range",
    );
    const afterChange = await readEvents(eventsPath);
    assert.equal(
      commandsFor(afterChange, secondRoot).some(
        (message) => message[0] === "change-range",
      ),
      false,
      "a change in one root must not reach another root session",
    );

    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.stop",
      arguments: [{ uri: firstUri, line: 0 }],
    });
    await waitFor(
      () => readEvents(eventsPath),
      (events) => {
        const firstProcess = events.find(
          (event) => event.type === "start" && event.root === firstRoot,
        );
        return (
          events.some(
            (event) =>
              (event.type === "signal" || event.type === "exit") &&
              event.root === firstRoot,
          ) ||
          (firstProcess?.pid !== undefined && !isProcessAlive(firstProcess.pid))
        );
      },
      "first root stop",
    );
    const afterFirstStop = await readEvents(eventsPath);
    assert.equal(
      afterFirstStop.some(
        (event) => event.type === "exit" && event.root === secondRoot,
      ),
      false,
      "stopping one root must leave the other root running",
    );
    const secondProcess = afterFirstStop.find(
      (event) => event.type === "start" && event.root === secondRoot,
    );
    assert.ok(secondProcess?.pid !== undefined && isProcessAlive(secondProcess.pid));

    await connection.sendRequest("workspace/executeCommand", {
      command: "texpresso-live.nextPage",
      arguments: [{ uri: secondUri, line: 0 }],
    });
    await waitFor(
      () => readEvents(eventsPath),
      (events) =>
        commandsFor(events, secondRoot).some(
          (message) => JSON.stringify(message) === JSON.stringify(["next-page"]),
        ),
      "second root control command after first root stop",
    );

    await connection.sendRequest("shutdown");
    await waitFor(
      () => readEvents(eventsPath),
      (events) => {
        const secondProcess = events.find(
          (event) => event.type === "start" && event.root === secondRoot,
        );
        return (
          events.some((event) => event.type === "exit" && event.root === secondRoot) ||
          (secondProcess?.pid !== undefined && !isProcessAlive(secondProcess.pid))
        );
      },
      "remaining root cleanup during shutdown",
    );
    const adapterExit = once(adapter, "exit");
    connection.sendNotification("exit");
    await adapterExit;
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
