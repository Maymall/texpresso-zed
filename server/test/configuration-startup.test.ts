import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { URI } from "vscode-uri";

import { createTexpressoServer } from "../src/server.js";
import type {
  ProcessFactory,
  TexpressoProcess,
} from "../src/texpresso-session.js";

class FakeProcess extends EventEmitter implements TexpressoProcess {
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor() {
    super();
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.killed = true;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    queueMicrotask(() => {
      this.emit("exit", this.exitCode, this.signalCode);
      this.emit("close", this.exitCode, this.signalCode);
    });
    return true;
  }
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
}

interface TestServer {
  readonly client: MessageConnection;
  readonly server: ReturnType<typeof createTexpressoServer>;
  readonly spawns: SpawnRecord[];
}

function createTestServer(): TestServer {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const spawns: SpawnRecord[] = [];
  const processFactory: ProcessFactory = (command, args) => {
    spawns.push({ command, args: [...args] });
    return new FakeProcess();
  };
  const server = createTexpressoServer(clientToServer, serverToClient, {
    processFactory,
  });
  const client = createMessageConnection(
    new StreamMessageReader(serverToClient),
    new StreamMessageWriter(clientToServer),
  );
  server.listen();
  client.listen();
  return { client, server, spawns };
}

async function settle(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await settle(1);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function closeTestServer(testServer: TestServer): Promise<void> {
  try {
    await testServer.client.sendRequest("shutdown");
    testServer.client.sendNotification("exit");
    await settle();
  } finally {
    testServer.client.dispose();
    testServer.server.dispose();
  }
}

function initializeParams(
  workspace: string,
  configuration: boolean,
  initializationOptions: unknown,
): object {
  const workspaceUri = URI.file(workspace).toString();
  return {
    processId: process.pid,
    rootUri: workspaceUri,
    workspaceFolders: [{ uri: workspaceUri, name: "configuration-startup" }],
    capabilities: configuration ? { workspace: { configuration: true } } : {},
    initializationOptions,
  };
}

test("waits for delayed workspace configuration before auto-starting TeXpresso", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "texpresso configuration "));
  const mainPath = path.join(workspace, "main.tex");
  const mainUri = URI.file(mainPath).toString();
  const mainText = "\\documentclass{article}\n\\begin{document}\nHello\n";
  const configuredCommand = "/custom/texpresso-wrapper";
  const testServer = createTestServer();
  let releaseConfiguration: ((value: readonly unknown[]) => void) | undefined;
  let markConfigurationRequested: (() => void) | undefined;
  const configurationRequested = new Promise<void>((resolve) => {
    markConfigurationRequested = resolve;
  });

  await writeFile(mainPath, mainText);
  testServer.client.onRequest("workspace/configuration", () => {
    markConfigurationRequested?.();
    return new Promise<readonly unknown[]>((resolve) => {
      releaseConfiguration = resolve;
    });
  });

  try {
    await testServer.client.sendRequest(
      "initialize",
      initializeParams(workspace, true, {}),
    );
    testServer.client.sendNotification("initialized", {});
    testServer.client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: mainUri,
        languageId: "latex",
        version: 1,
        text: mainText,
      },
    });

    await configurationRequested;
    await settle();
    assert.deepEqual(
      testServer.spawns,
      [],
      "didOpen must not spawn the DEFAULT_COMMAND while configuration is pending",
    );

    releaseConfiguration?.([
      {
        texpressoCommand: configuredCommand,
        distribution: "tectonic",
        autoStart: true,
      },
    ]);
    await waitFor(
      () => testServer.spawns.length === 1,
      "configured TeXpresso process",
    );
    assert.deepEqual(testServer.spawns, [
      {
        command: configuredCommand,
        args: ["-tectonic", "-json", "-lines", mainPath],
      },
    ]);
  } finally {
    releaseConfiguration?.([]);
    await closeTestServer(testServer);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("uses initializationOptions immediately when workspace configuration is unsupported", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "texpresso initialization "));
  const mainPath = path.join(workspace, "main.tex");
  const mainUri = URI.file(mainPath).toString();
  const mainText = "\\documentclass{article}\n\\begin{document}\nHello\n";
  const initializationCommand = "/initialization-options/texpresso";
  const changedCommand = "/runtime-configuration/texpresso";
  const testServer = createTestServer();

  await writeFile(mainPath, mainText);
  try {
    await testServer.client.sendRequest(
      "initialize",
      initializeParams(workspace, false, {
        texpressoCommand: initializationCommand,
        autoStart: true,
      }),
    );
    testServer.client.sendNotification("initialized", {});
    testServer.client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: mainUri,
        languageId: "latex",
        version: 1,
        text: mainText,
      },
    });

    await waitFor(
      () => testServer.spawns.length === 1,
      "initializationOptions TeXpresso process",
    );
    assert.deepEqual(testServer.spawns, [
      {
        command: initializationCommand,
        args: ["-json", "-lines", mainPath],
      },
    ]);

    testServer.client.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        "texpresso-live": {
          texpressoCommand: changedCommand,
          autoStart: true,
        },
      },
    });
    await waitFor(
      () => testServer.spawns.length === 2,
      "runtime configuration TeXpresso restart",
    );
    assert.deepEqual(testServer.spawns.at(-1), {
      command: changedCommand,
      args: ["-json", "-lines", mainPath],
    });
  } finally {
    await closeTestServer(testServer);
    await rm(workspace, { recursive: true, force: true });
  }
});
