import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { URI } from "vscode-uri";

interface WrapperInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await delay(15);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function wrapperInvocation(eventsPath: string): Promise<WrapperInvocation | undefined> {
  try {
    return JSON.parse(await readFile(eventsPath, "utf8")) as WrapperInvocation;
  } catch {
    return undefined;
  }
}

function releaseAdapterPath(): string {
  const configured = process.env.TEXPRESSO_RELEASE_ADAPTER;
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve("dist/server.mjs");
}

test(
  "a release adapter staged in an empty work directory spawns the configured absolute command",
  { skip: process.platform === "win32" },
  async () => {
    const releaseAdapter = releaseAdapterPath();
    const packageJson = JSON.parse(
      await readFile(path.resolve("package.json"), "utf8"),
    ) as { version: string };
    const workspace = await mkdtemp(path.join(tmpdir(), "texpresso release smoke "));
    const workDirectory = path.join(workspace, "zed-empty-work");
    const mainPath = path.join(workspace, "main.tex");
    const wrapperPath = path.join(workspace, "custom-texpresso-wrapper");
    const wrapperEventsPath = path.join(workspace, "wrapper-events.json");
    const wrapperProgramPath = path.join(workspace, "custom-texpresso-wrapper.cjs");
    const stagedAdapter = path.join(
      workDirectory,
      `texpresso-live-adapter-v${packageJson.version}.mjs`,
    );
    const mainText = "\\documentclass{article}\n\\begin{document}\nrelease smoke\n";
    const configuredSettings = {
      texpressoCommand: wrapperPath,
      autoStart: true,
      distribution: "texlive",
    };
    const zedSettings = {
      lsp: {
        "texpresso-live": {
          settings: configuredSettings,
        },
      },
    };
    const emptyPath = path.join(workspace, "empty-path");
    let adapter: ChildProcess | undefined;
    let connection: MessageConnection | undefined;
    const stderr: Buffer[] = [];

    try {
      await Promise.all([
        writeFile(mainPath, mainText),
        writeFile(
          wrapperProgramPath,
          `const fs = require("node:fs");
fs.writeFileSync(process.env.TEXPRESSO_RELEASE_SMOKE_EVENTS, JSON.stringify({ executable: process.argv[1], args: process.argv.slice(2) }));
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));
`,
        ),
      ]);
      await writeFile(
        wrapperPath,
        `#!${process.execPath}\nrequire(${JSON.stringify(wrapperProgramPath)});\n`,
      );
      await chmod(wrapperPath, 0o755);
      await rm(workDirectory, { recursive: true, force: true });
      await mkdir(workDirectory);
      await copyFile(releaseAdapter, stagedAdapter);

      adapter = spawn(process.execPath, [stagedAdapter], {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: emptyPath,
          TEXPRESSO_RELEASE_SMOKE_EVENTS: wrapperEventsPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      adapter.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      connection = createMessageConnection(
        new StreamMessageReader(adapter.stdout!),
        new StreamMessageWriter(adapter.stdin!),
      );
      connection.onRequest("workspace/configuration", () => [configuredSettings]);
      connection.listen();

      await connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: URI.file(workspace).toString(),
        workspaceFolders: [{ uri: URI.file(workspace).toString(), name: "release-smoke" }],
        capabilities: { workspace: { configuration: true } },
        initializationOptions: {
          settings: zedSettings.lsp["texpresso-live"].settings,
        },
      });
      connection.sendNotification("initialized", {});
      connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: URI.file(mainPath).toString(),
          languageId: "latex",
          version: 1,
          text: mainText,
        },
      });

      const invocation = await waitFor(
        () => wrapperInvocation(wrapperEventsPath),
        (value): value is WrapperInvocation => value !== undefined,
        "configured absolute TeXpresso wrapper invocation",
      );
      assert.equal(invocation.executable, wrapperPath);
      assert.deepEqual(invocation.args, ["-json", "-lines", "-texlive", mainPath]);

      await connection.sendRequest("shutdown");
      const adapterExit = once(adapter, "exit");
      connection.sendNotification("exit");
      await adapterExit;
      assert.equal(Buffer.concat(stderr).toString("utf8"), "");
    } finally {
      connection?.dispose();
      if (adapter && adapter.exitCode === null && !adapter.killed) {
        const adapterExit = once(adapter, "exit");
        adapter.kill("SIGTERM");
        await adapterExit.catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
