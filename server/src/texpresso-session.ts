/**
 * The process/VFS half of the TeXpresso adapter.
 *
 * TeXpresso deliberately has an asynchronous, best-effort protocol.  This
 * module therefore does not try to pair requests with replies.  It owns one
 * child process, serialises all writes to its stdin, and keeps enough VFS
 * state to reconstruct the process after a reset or restart.
 */

import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { Diagnostic, Range } from "vscode-languageserver-types";

import {
  DiagnosticState,
  parseDiagnosticLine,
  type DiagnosticFlushResult,
} from "./diagnostics.js";
import { NdjsonParser, encodeMessage, type TeXpressoMessage } from "./protocol.js";
import { applyUtf16RangeChange } from "./utf16.js";

/** Settings accepted by the adapter.  Optional fields use TeXpresso's CLI defaults. */
export interface SessionSettings {
  command?: string;
  includePaths?: readonly string[];
  distribution?: "default" | "texlive" | "tectonic";
  extraArgs?: readonly string[];
  /** Alias accepted for callers that expose the setting as additionalArgs. */
  additionalArgs?: readonly string[];
  showBoxWarnings?: boolean;
  logLevel?: string;
  /** Used by tests and by embedders that need a deterministic shutdown timeout. */
  stopTimeoutMs?: number;
}

export interface DocumentChange {
  range?: Range;
  text: string;
}

/**
 * `showDocument` receives a zero-based line.  TeXpresso's wire protocol uses
 * one-based lines, and the conversion is intentionally kept inside the
 * session so every consumer sees normal LSP coordinates.
 */
export interface SessionCallbacks {
  publishDiagnostics(uri: string, diagnostics: Diagnostic[]): void;
  showDocument?(path: string, line: number): void | Promise<void>;
  log?(level: number | string, message: string): void;
  /** Look up an unsaved editor buffer which has not yet been announced to us. */
  getOpenDocument?(path: string): string | undefined;
  /** Called once for every process termination, including a clean viewer close. */
  exited?(error?: Error): void;
}

/** Minimal child-process surface used by the real process and unit-test fakes. */
export interface TexpressoProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number | undefined;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ProcessSpawnOptions extends SpawnOptionsWithoutStdio {
  shell?: false;
}

export type ProcessFactory = (
  command: string,
  args: readonly string[],
  options: ProcessSpawnOptions,
) => TexpressoProcess;

export interface InputFileRecord {
  index: number;
  /** Path as emitted by TeXpresso, retained for diagnostics/debugging. */
  relativePath: string;
  absolutePath: string;
}

export interface TrackedDocument {
  path: string;
  text: string;
  editorOpen: boolean;
  /** Paths currently represented in TeXpresso's VFS for this document. */
  vfsPaths: readonly string[];
  /** True when the path is still referenced by root/input/lookup tracking. */
  referenced: boolean;
}

interface MutableDocument {
  path: string;
  text: string;
  editorOpen: boolean;
  vfsPaths: Set<string>;
}

interface QueuedWrite {
  payload: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface CloseWaiter {
  resolve: () => void;
}

type SessionState = "stopped" | "starting" | "running" | "stopping";

const DEFAULT_COMMAND = "texpresso";
const DEFAULT_STOP_TIMEOUT_MS = 1_500;

// Child processes are not automatically reaped when the adapter itself is
// torn down.  Keep a small process registry and synchronously signal children
// during Node's exit phase.  (Calling kill is one of the operations permitted
// during `exit`; waiting for a Promise there is not.)
const liveProcesses = new Set<TexpressoProcess>();
let processExitHookInstalled = false;

function installProcessExitHook(): void {
  if (processExitHookInstalled) {
    return;
  }
  processExitHookInstalled = true;
  process.once("exit", () => {
    for (const child of liveProcesses) {
      try {
        if (child.exitCode === null) {
          // `killed` only means a signal was sent, not that the process has
          // exited. Escalate an already-signalled child during the adapter's
          // final synchronous cleanup instead of silently orphaning it.
          child.kill(child.killed ? "SIGKILL" : "SIGTERM");
        }
      } catch {
        // The process may already have disappeared; there is nothing useful
        // to do during Node's synchronous exit phase.
      }
    }
    liveProcesses.clear();
  });
}

function asError(value: unknown, fallback = "TeXpresso process failed"): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return new Error(value);
  }
  return new Error(fallback);
}

function isWritable(value: Writable | undefined): value is Writable {
  return Boolean(
    value &&
      !value.destroyed &&
      !value.writableEnded &&
      !value.writableFinished,
  );
}

function pathKey(path: string): string {
  const value = normalize(path);
  // TeXpresso is primarily used on Linux, but lower-casing drive paths keeps
  // tests and adapters running under Windows from creating duplicate entries.
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pathAliases(path: string): Set<string> {
  const aliases = new Set<string>();
  const absolute = pathKey(path);
  aliases.add(absolute);
  try {
    if (existsSync(absolute)) {
      aliases.add(pathKey(realpathSync.native(absolute)));
    }
  } catch {
    // A path emitted by TeXpresso may exist only in its VFS.  Keep the
    // normalized spelling and do not make existence a protocol requirement.
  }
  return aliases;
}

function pathsEqual(left: string, right: string): boolean {
  const rightAliases = pathAliases(right);
  for (const alias of pathAliases(left)) {
    if (rightAliases.has(alias)) {
      return true;
    }
  }
  return false;
}

function pathIsWithin(candidate: string, parent: string): boolean {
  for (const candidateAlias of pathAliases(candidate)) {
    for (const parentAlias of pathAliases(parent)) {
      const difference = relative(parentAlias, candidateAlias);
      if (
        difference === "" ||
        (!difference.startsWith("..") && !isAbsolute(difference))
      ) {
        return true;
      }
    }
  }
  return false;
}

function toAbsolute(rootPath: string, path: string): string {
  return pathKey(isAbsolute(path) ? path : resolve(dirname(rootPath), path));
}

function isProtocolMessage(value: unknown): value is TeXpressoMessage {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === "string";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function logPriority(level: number | string | undefined): number {
  if (typeof level === "number") {
    return Math.max(0, Math.min(3, Math.trunc(level) - 1));
  }
  switch (level?.toLowerCase()) {
    case "error":
      return 0;
    case "warn":
    case "warning":
      return 1;
    case "info":
    case "log":
      return 2;
    case "debug":
      return 3;
    case "trace":
      return 4;
    default:
      return 2;
  }
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function sameDiagnostic(left: Diagnostic, right: Diagnostic): boolean {
  return (
    left.severity === right.severity &&
    left.message === right.message &&
    left.range.start.line === right.range.start.line &&
    left.range.start.character === right.range.start.character &&
    left.range.end.line === right.range.end.line &&
    left.range.end.character === right.range.end.character
  );
}

export class TexpressoSession {
  readonly rootPath: string;

  private settings: SessionSettings;
  private callbacks: SessionCallbacks;
  private readonly processFactory: ProcessFactory;
  private readonly documents = new Map<string, MutableDocument>();
  private readonly inputFiles = new Map<number, InputFileRecord>();
  private readonly lookupFiles = new Map<string, string>();
  private readonly diagnostics: DiagnosticState;
  private readonly protocolDiagnosticsByUri = new Map<string, Diagnostic[]>();
  private readonly stderrDiagnosticsByUri = new Map<string, Diagnostic[]>();
  private readonly publishedDiagnosticUris = new Set<string>();
  private readonly writeQueue: QueuedWrite[] = [];
  private readonly pendingWrites = new Set<QueuedWrite>();
  private readonly closeWaiters: CloseWaiter[] = [];
  private readonly reconcilePromises = new Map<string, Promise<void>>();

  private child: TexpressoProcess | undefined;
  private state: SessionState = "stopped";
  private parser = new NdjsonParser();
  private stderrDecoder = new StringDecoder("utf8");
  private stderrLineBuffer = "";
  private writeBlocked = false;
  private writeScheduled = false;
  private processError: Error | undefined;
  private closeHandled = false;
  private shutdownRequested = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private startResolve: (() => void) | undefined;
  private startReject: ((error: Error) => void) | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimerChild: TexpressoProcess | undefined;

  constructor(
    rootPath: string,
    settings: SessionSettings = {},
    callbacks: SessionCallbacks,
    processFactory: ProcessFactory = defaultProcessFactory,
  ) {
    this.rootPath = pathKey(isAbsolute(rootPath) ? rootPath : resolve(rootPath));
    this.settings = { ...settings };
    this.callbacks = callbacks;
    this.processFactory = processFactory;
    this.diagnostics = new DiagnosticState({
      rootPath: this.rootPath,
      showBoxWarnings: settings.showBoxWarnings ?? false,
    });
    installProcessExitHook();
  }

  get running(): boolean {
    return this.state === "running";
  }

  get process(): TexpressoProcess | undefined {
    return this.child;
  }

  /** A snapshot useful to tests and diagnostics; callers cannot mutate state. */
  get trackedFiles(): readonly InputFileRecord[] {
    return [...this.inputFiles.values()].sort((a, b) => a.index - b.index);
  }

  get documentsSnapshot(): readonly TrackedDocument[] {
    return [...this.documents.values()].map((document) => ({
      path: document.path,
      text: document.text,
      editorOpen: document.editorOpen,
      vfsPaths: [...document.vfsPaths],
      referenced: this.isReferenced(document.path),
    }));
  }

  /** Start one TeXpresso process. Concurrent calls share the same Promise. */
  start(): Promise<void> {
    if (this.shutdownRequested) {
      return Promise.reject(new Error("TeXpresso session has been shut down"));
    }
    if (this.state === "stopping") {
      const stopPromise = this.stopPromise ?? Promise.resolve();
      return stopPromise.then(() => this.start());
    }
    if (this.state === "running") {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.state = "starting";
    this.processError = undefined;
    this.closeHandled = false;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
      this.closeTimerChild = undefined;
    }
    // These paths describe the VFS of one concrete child process. Cached
    // document text survives a restart, but the new process starts empty.
    this.invalidateVfs();
    this.parser.reset();
    this.stderrDecoder = new StringDecoder("utf8");
    this.stderrLineBuffer = "";
    this.writeBlocked = false;

    const args = this.buildArgs();
    const command = this.settings.command?.trim() || DEFAULT_COMMAND;
    this.log("info", `Starting TeXpresso: ${commandLabel(command, args)}`);

    let resolveStart: () => void = () => undefined;
    let rejectStart: (error: Error) => void = () => undefined;
    const startPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveStart = resolvePromise;
      rejectStart = rejectPromise;
    });
    this.startPromise = startPromise;
    this.startResolve = resolveStart;
    this.startReject = rejectStart;

    let child: TexpressoProcess;
    try {
      child = this.processFactory(command, args, {
        cwd: dirname(this.rootPath),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = asError(error, `Unable to start ${command}`);
      this.handleStartFailure(failure);
      return startPromise;
    }

    this.child = child;
    liveProcesses.add(child);
    this.attachProcess(child);

    // ChildProcess emits `spawn` on the next turn. Fakes occasionally do not
    // implement it, so a process with an assigned pid also starts next turn.
    let spawned = false;
    const markSpawned = (): void => {
      if (spawned || this.child !== child || this.state !== "starting") {
        return;
      }
      spawned = true;
      this.state = "running";
      this.startResolve?.();
      this.startResolve = undefined;
      this.startReject = undefined;
      this.startPromise = undefined;
      this.reconcileAllDocuments();
      this.flushWriteQueue();
    };
    child.once("spawn", markSpawned);
    queueMicrotask(() => {
      if (child.pid !== undefined && child.pid !== null) {
        markSpawned();
      }
    });
    return startPromise;
  }

  /** Stop the child, escalating to SIGKILL if it does not close promptly. */
  stop(): Promise<void> {
    if (this.state === "stopped" && !this.child) {
      this.clearPublishedDiagnostics();
      return Promise.resolve();
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.state = "stopping";
    this.rejectQueuedWrites(new Error("TeXpresso session stopped"));
    let resolveStop: () => void = () => undefined;
    const stopPromise = new Promise<void>((resolvePromise) => {
      resolveStop = resolvePromise;
    });
    this.stopPromise = stopPromise;
    this.closeWaiters.push({ resolve: resolveStop });
    const child = this.child;
    if (!child) {
      this.finishClose();
      return stopPromise;
    }
    try {
      if (isWritable(child.stdin)) {
        child.stdin.end();
      }
    } catch (error) {
      this.log("warning", `Unable to close TeXpresso stdin: ${asError(error).message}`);
    }
    try {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
    } catch (error) {
      this.log("warning", `Unable to terminate TeXpresso: ${asError(error).message}`);
    }
    if (this.child === child && !this.closeHandled) {
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        this.closeTimerChild = undefined;
      }
      const timeout = Math.max(
        0,
        this.settings.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      );
      this.closeTimer = setTimeout(() => {
        if (this.child !== child || this.closeHandled) {
          return;
        }
        try {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        } catch (error) {
          this.log("warning", `Unable to force-stop TeXpresso: ${asError(error).message}`);
        }
        // Well-behaved ChildProcess instances emit close after SIGKILL.  A
        // minimal fake may not, so finalize rather than leaving a zombie
        // Promise and process registry entry forever.
        setTimeout(() => {
          if (this.child === child && !this.closeHandled) {
            // Unblock shutdown even if a broken child never emits close, but
            // retain it in liveProcesses until a real close arrives.
            this.finishClose(child, false);
          }
        }, Math.min(250, Math.max(1, timeout))).unref?.();
      }, timeout);
      this.closeTimerChild = child;
      this.closeTimer.unref?.();
    }
    return stopPromise;
  }

  /** Permanently stop this session and reject any queued restart. */
  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    return this.stop();
  }

  async restart(settings?: SessionSettings): Promise<void> {
    await this.stop();
    if (settings) {
      this.settings = { ...settings };
    }
    this.diagnostics.clear();
    await this.start();
  }

  /** Open or replace a buffer in the session's VFS cache. */
  async openDocument(path: string, text: string): Promise<void> {
    this.clearStderrDiagnostics();
    const absolutePath = toAbsolute(this.rootPath, path);
    const document = this.getOrCreateDocument(absolutePath);
    const retainedPaths = document.editorOpen ? [] : [...document.vfsPaths];
    document.text = text;
    document.editorOpen = true;
    // Keep editor buffers even while TeXpresso has temporarily dropped its
    // reference.  A later input-file/lookup-file message can then reuse the
    // current overlay, and didClose can still find the document to release it.
    await this.scheduleReconcile(document, retainedPaths);
  }

  /** Apply one incremental LSP change (or replace the whole document). */
  async changeDocument(path: string, change: DocumentChange): Promise<void> {
    const absolutePath = toAbsolute(this.rootPath, path);
    const document = this.findDocument(absolutePath);
    if (!document || !document.editorOpen) {
      return;
    }
    this.clearStderrDiagnostics();
    if (change.range) {
      document.text = applyUtf16RangeChange(
        document.text,
        change.range,
        change.text,
      );
    } else {
      document.text = change.text;
    }

    if (!this.child || this.state !== "running") {
      return;
    }
    if (!change.range) {
      // A full-text LSP change has no stable old range.  `open` is atomic and
      // keeps the VFS correct for both old and new TeXpresso versions.
      for (const vfsPath of document.vfsPaths) {
        await this.send(["open", vfsPath, document.text]);
      }
      return;
    }
    for (const vfsPath of document.vfsPaths) {
      await this.send([
        "change-range",
        vfsPath,
        change.range.start.line,
        change.range.start.character,
        change.range.end.line,
        change.range.end.character,
        change.text,
      ]);
    }
  }

  /**
   * Mark a buffer closed. Its complete text remains cached in the VFS while
   * TeXpresso references it, so reset/restart can reconstruct the overlay.
   * Index rollback later closes and prunes a no-longer-referenced buffer.
   */
  async closeDocument(path: string): Promise<void> {
    const absolutePath = toAbsolute(this.rootPath, path);
    const document = this.findDocument(absolutePath);
    if (!document) {
      return;
    }
    document.editorOpen = false;
    await this.scheduleReconcile(document);
  }

  ownsPath(path: string): boolean {
    const absolutePath = toAbsolute(this.rootPath, path);
    return this.isReferenced(absolutePath);
  }

  /** Whether this session has a cached/editor buffer or a live VFS reference. */
  tracksPath(path: string): boolean {
    const absolutePath = toAbsolute(this.rootPath, path);
    return this.findDocument(absolutePath) !== undefined || this.isReferenced(absolutePath);
  }

  /** Whether a root, input, lookup, or cached document is at/below a path. */
  tracksPathAtOrBelow(path: string): boolean {
    const absolutePath = toAbsolute(this.rootPath, path);
    if (pathIsWithin(this.rootPath, absolutePath)) {
      return true;
    }
    for (const input of this.inputFiles.values()) {
      if (pathIsWithin(input.absolutePath, absolutePath)) {
        return true;
      }
    }
    for (const lookupPath of this.lookupFiles.keys()) {
      if (pathIsWithin(lookupPath, absolutePath)) {
        return true;
      }
    }
    for (const document of this.documents.values()) {
      if (pathIsWithin(document.path, absolutePath)) {
        return true;
      }
    }
    return false;
  }

  forwardSync(path: string, line: number): Promise<void> {
    return this.sendIfRunning([
      "synctex-forward",
      toAbsolute(this.rootPath, path),
      Math.max(1, Math.floor(line) + 1),
    ]);
  }

  nextPage(): Promise<void> {
    return this.sendIfRunning(["next-page"]);
  }

  previousPage(): Promise<void> {
    return this.sendIfRunning(["previous-page"]);
  }

  rescan(): Promise<void> {
    this.clearStderrDiagnostics();
    return this.sendIfRunning(["rescan"]);
  }

  pause(): Promise<void> {
    return this.sendIfRunning(["pause"]);
  }

  resume(): Promise<void> {
    return this.sendIfRunning(["resume"]);
  }

  /** Public alias used by command handlers. */
  sendControl(command: "next-page" | "previous-page" | "rescan" | "pause" | "resume"): Promise<void> {
    return this.sendIfRunning([command]);
  }

  /** Return a stable registry snapshot for lookup-file/input-file consumers. */
  getInputFile(index: number): InputFileRecord | undefined {
    const record = this.inputFiles.get(index);
    return record ? { ...record } : undefined;
  }

  private buildArgs(): string[] {
    const args = ["-json", "-lines"];
    if (this.settings.distribution === "texlive") {
      args.push("-texlive");
    } else if (this.settings.distribution === "tectonic") {
      args.push("-tectonic");
    }
    for (const includePath of this.settings.includePaths ?? []) {
      args.push("-I", includePath);
    }
    const additional = this.settings.extraArgs ?? this.settings.additionalArgs ?? [];
    args.push(...additional);
    args.push(this.rootPath);
    return args;
  }

  private attachProcess(child: TexpressoProcess): void {
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (this.child !== child) {
        return;
      }
      const batch = this.parser.push(chunk);
      for (const error of batch.errors) {
        this.log("warning", `Invalid TeXpresso message: ${error.error.message}`);
      }
      for (const message of batch.messages) {
        this.handleMessage(message);
      }
    });
    child.stdout.on("error", (error: Error) => {
      if (this.child !== child) {
        return;
      }
      this.log("error", `TeXpresso stdout error: ${error.message}`);
      this.processError ??= error;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (this.child !== child) {
        return;
      }
      this.handleStderrChunk(chunk);
    });
    child.stderr.on("error", (error: Error) => {
      if (this.child !== child) {
        return;
      }
      this.log("warning", `TeXpresso stderr error: ${error.message}`);
    });
    child.stdin.on("error", (error: Error) => {
      if (this.child !== child) {
        return;
      }
      const failure = asError(error, "TeXpresso stdin failed");
      this.handleStdinFailure(failure);
    });
    child.stdin.on("drain", () => {
      if (this.child !== child) {
        return;
      }
      this.writeBlocked = false;
      this.flushWriteQueue();
    });
    child.on("error", (error: Error) => {
      if (this.child !== child) {
        return;
      }
      const failure = asError(error);
      this.processError ??= failure;
      if (this.state === "starting") {
        this.handleStartFailure(failure, child);
      }
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) {
        return;
      }
      if (code !== null && code !== 0) {
        this.processError ??= new Error(`TeXpresso exited with code ${code}`);
      } else if (signal) {
        this.processError ??= new Error(`TeXpresso terminated by ${signal}`);
      }
    });
    child.on("close", () => {
      this.finishClose(child);
    });
  }

  private handleStartFailure(error: Error, child?: TexpressoProcess): void {
    if (child && this.child !== child) {
      return;
    }
    const failedChild = child ?? this.child;
    this.processError = error;
    this.startReject?.(error);
    this.startResolve = undefined;
    this.startReject = undefined;
    this.startPromise = undefined;
    if (failedChild && this.child === failedChild) {
      if (this.closeTimer && this.closeTimerChild === failedChild) {
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        this.closeTimerChild = undefined;
      }
      try {
        if (failedChild.exitCode === null) {
          failedChild.kill(failedChild.killed ? "SIGKILL" : "SIGTERM");
        }
      } catch {
        // The close event or the process-exit hook will finish cleanup.
      }
      // Detach the failed child before allowing a retry. Its identity-bound
      // close handler still removes it from liveProcesses when it eventually
      // exits, so a partial spawn cannot be orphaned by the replacement.
      this.child = undefined;
    }
    this.state = "stopped";
    this.rejectQueuedWrites(error);
  }

  private finishClose(
    expectedChild?: TexpressoProcess,
    processClosed = true,
  ): void {
    if (expectedChild && this.child !== expectedChild) {
      if (this.closeTimer && this.closeTimerChild === expectedChild) {
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        this.closeTimerChild = undefined;
      }
      if (processClosed) {
        liveProcesses.delete(expectedChild);
      }
      return;
    }
    if (this.closeHandled) {
      return;
    }
    this.closeHandled = true;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
      this.closeTimerChild = undefined;
    }
    const child = expectedChild ?? this.child;
    if (child && processClosed) {
      liveProcesses.delete(child);
    }
    const wasIntentional = this.state === "stopping";
    const error = this.processError;
    this.child = undefined;
    this.state = "stopped";
    this.writeBlocked = false;
    this.invalidateVfs();
    this.rejectQueuedWrites(error ?? new Error("TeXpresso process closed"));
    this.finishStderr();
    const finalBatch = this.parser.finish();
    for (const parseError of finalBatch.errors) {
      this.log("warning", `Invalid TeXpresso message at process exit: ${parseError.error.message}`);
    }
    for (const message of finalBatch.messages) {
      this.handleMessage(message);
    }
    this.clearPublishedDiagnostics();
    if (this.startReject) {
      this.startReject(error ?? new Error("TeXpresso process closed before start"));
      this.startResolve = undefined;
      this.startReject = undefined;
      this.startPromise = undefined;
    }
    const waiters = this.closeWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
    const stopPromise = this.stopPromise;
    this.stopPromise = undefined;
    if (!wasIntentional && this.callbacks.exited) {
      try {
        this.callbacks.exited(error);
      } catch (callbackError) {
        this.log("error", `Session exit callback failed: ${asError(callbackError).message}`);
      }
    }
    // Avoid retaining a resolved stop Promise across future starts.
    void stopPromise;
  }

  private handleStderrChunk(chunk: Buffer | string): void {
    const text =
      typeof chunk === "string" ? chunk : this.stderrDecoder.write(chunk);
    this.stderrLineBuffer += text;
    while (true) {
      const newline = this.stderrLineBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.stderrLineBuffer
        .slice(0, newline)
        .replace(/\r$/u, "");
      this.stderrLineBuffer = this.stderrLineBuffer.slice(newline + 1);
      this.handleStderrLine(line);
    }
  }

  private finishStderr(): void {
    const tail = this.stderrDecoder.end();
    if (tail.length > 0) {
      this.handleStderrChunk(tail);
    }
    if (this.stderrLineBuffer.length > 0) {
      const line = this.stderrLineBuffer.replace(/\r$/u, "");
      this.stderrLineBuffer = "";
      this.handleStderrLine(line);
    }
  }

  private handleStderrLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    this.log("log", line);
    let parsed;
    try {
      parsed = parseDiagnosticLine(line, {
        rootPath: this.rootPath,
        showBoxWarnings: this.settings.showBoxWarnings ?? false,
      });
    } catch (error) {
      this.log("warning", `Unable to parse TeXpresso stderr diagnostic: ${asError(error).message}`);
      return;
    }
    if (!parsed) {
      return;
    }
    const diagnostics = this.stderrDiagnosticsByUri.get(parsed.uri) ?? [];
    const diagnostic = parsed.diagnostic as Diagnostic;
    if (!diagnostics.some((existing) => sameDiagnostic(existing, diagnostic))) {
      diagnostics.push(diagnostic);
      this.stderrDiagnosticsByUri.set(parsed.uri, diagnostics);
      this.publishCombinedDiagnostics();
    }
  }

  private clearStderrDiagnostics(): void {
    if (this.stderrDiagnosticsByUri.size === 0) {
      return;
    }
    this.stderrDiagnosticsByUri.clear();
    this.publishCombinedDiagnostics();
  }

  private clearPublishedDiagnostics(): void {
    try {
      this.diagnostics.clear();
      this.protocolDiagnosticsByUri.clear();
      this.stderrDiagnosticsByUri.clear();
      this.publishCombinedDiagnostics();
    } catch (error) {
      this.log("warning", `Unable to clear TeXpresso diagnostics: ${asError(error).message}`);
    }
  }

  private handleMessage(message: TeXpressoMessage): void {
    if (!isProtocolMessage(message)) {
      return;
    }
    const kind = message[0];
    switch (kind) {
      case "input-file":
        this.handleInputFile(message);
        break;
      case "lookup-file":
        this.handleLookupFile(message);
        break;
      case "reset-sync":
        this.handleResetSync();
        break;
      case "synctex":
        this.handleSynctex(message);
        break;
      case "append-lines":
        this.handleAppendLines(message);
        break;
      case "truncate-lines":
        this.handleTruncateLines(message);
        break;
      case "append":
        this.handleAppend(message);
        break;
      case "truncate":
        this.handleTruncate(message);
        break;
      case "flush":
        this.handleFlush();
        break;
      default:
        this.log("debug", `Unhandled TeXpresso message: ${JSON.stringify(message)}`);
        break;
    }
  }

  private handleInputFile(message: TeXpressoMessage): void {
    const index = numberValue(message[1]);
    const relativePath = stringValue(message[2]);
    if (index === undefined || relativePath === undefined || index < 0 || !Number.isInteger(index)) {
      this.log("warning", `Malformed input-file message: ${JSON.stringify(message)}`);
      return;
    }
    for (const existingIndex of [...this.inputFiles.keys()]) {
      if (existingIndex > index) {
        this.inputFiles.delete(existingIndex);
      }
    }
    const absolutePath = toAbsolute(this.rootPath, relativePath);
    this.inputFiles.set(index, { index, relativePath, absolutePath });
    const text = this.findOpenText(absolutePath);
    if (text !== undefined) {
      this.clearStderrDiagnostics();
      const document = this.getOrCreateDocument(absolutePath);
      document.text = text;
      document.editorOpen = true;
      void this.scheduleReconcile(document, [absolutePath]);
    }
    this.reconcileAllDocuments();
  }

  private handleLookupFile(message: TeXpressoMessage): void {
    const status = stringValue(message[2]);
    const filePath = stringValue(message[3]);
    if (!status || !filePath) {
      this.log("warning", `Malformed lookup-file message: ${JSON.stringify(message)}`);
      return;
    }
    const absolutePath = toAbsolute(this.rootPath, filePath);
    this.lookupFiles.set(pathKey(absolutePath), filePath);
    const text = this.findOpenText(absolutePath);
    if (text !== undefined) {
      this.clearStderrDiagnostics();
      const document = this.getOrCreateDocument(absolutePath);
      document.text = text;
      document.editorOpen = true;
      void this.scheduleReconcile(document, [absolutePath]);
    } else if (status === "promised") {
      this.log(
        "warning",
        `TeXpresso is waiting for an editor buffer for ${absolutePath}; open the file in Zed or save it to disk.`,
      );
    }
  }

  private handleResetSync(): void {
    this.log("info", "TeXpresso reset its VFS; resending open buffers");
    this.clearStderrDiagnostics();
    this.invalidateVfs();
    this.reconcileAllDocuments();
  }

  private handleSynctex(message: TeXpressoMessage): void {
    const path = stringValue(message[1]);
    const line = numberValue(message[2]);
    if (!path || line === undefined) {
      this.log("warning", `Malformed synctex message: ${JSON.stringify(message)}`);
      return;
    }
    const absolutePath = toAbsolute(this.rootPath, path);
    const zeroBasedLine = Math.max(0, Math.floor(line) - 1);
    if (this.callbacks.showDocument) {
      Promise.resolve(this.callbacks.showDocument(absolutePath, zeroBasedLine)).catch((error: unknown) => {
        this.log("warning", `Unable to show SyncTeX target: ${asError(error).message}`);
      });
    }
  }

  private handleAppendLines(message: TeXpressoMessage): void {
    const channel = message[1];
    if (channel !== "out" && channel !== "log") {
      this.log("debug", `Unhandled append-lines channel: ${JSON.stringify(message)}`);
      return;
    }
    const lines = message.slice(2).filter((line): line is string => typeof line === "string");
    try {
      this.diagnostics.appendLines(channel, lines);
    } catch (error) {
      this.log("warning", `Unable to append TeXpresso ${channel} lines: ${asError(error).message}`);
    }
  }

  private handleTruncateLines(message: TeXpressoMessage): void {
    const channel = message[1];
    const count = numberValue(message[2]);
    if ((channel !== "out" && channel !== "log") || count === undefined) {
      this.log("warning", `Malformed truncate-lines message: ${JSON.stringify(message)}`);
      return;
    }
    try {
      this.diagnostics.truncateLines(channel, Math.max(0, Math.floor(count)));
    } catch (error) {
      this.log("warning", `Unable to truncate TeXpresso ${channel}: ${asError(error).message}`);
    }
  }

  private handleAppend(message: TeXpressoMessage): void {
    const channel = message[1];
    if (channel !== "out" && channel !== "log") {
      return;
    }
    // Current JSON protocol uses ["append", channel, text].  Accept the old
    // occasional four-element form as well, where text was at index 3.
    const text = stringValue(message[2]) ?? stringValue(message[3]);
    if (text === undefined) {
      return;
    }
    try {
      this.diagnostics.append(channel, text);
    } catch (error) {
      this.log("warning", `Unable to append TeXpresso ${channel}: ${asError(error).message}`);
    }
  }

  private handleTruncate(message: TeXpressoMessage): void {
    const channel = message[1];
    const count = numberValue(message[2]);
    if ((channel !== "out" && channel !== "log") || count === undefined) {
      return;
    }
    try {
      this.diagnostics.truncate(channel, Math.max(0, Math.floor(count)));
    } catch (error) {
      this.log("warning", `Unable to truncate TeXpresso ${channel}: ${asError(error).message}`);
    }
  }

  private handleFlush(): void {
    try {
      this.publishDiagnosticsResult(this.diagnostics.flush());
    } catch (error) {
      this.log("warning", `Unable to publish TeXpresso diagnostics: ${asError(error).message}`);
    }
  }

  private publishDiagnosticsResult(result: DiagnosticFlushResult): void {
    this.protocolDiagnosticsByUri.clear();
    for (const [uri, diagnostics] of result.byUri) {
      this.protocolDiagnosticsByUri.set(uri, [...diagnostics] as Diagnostic[]);
    }
    this.publishCombinedDiagnostics();
    for (const line of result.logLines) {
      this.log("log", line);
    }
  }

  private publishCombinedDiagnostics(): void {
    const currentUris = new Set([
      ...this.protocolDiagnosticsByUri.keys(),
      ...this.stderrDiagnosticsByUri.keys(),
    ]);
    for (const uri of currentUris) {
      const diagnostics = [
        ...(this.protocolDiagnosticsByUri.get(uri) ?? []),
        ...(this.stderrDiagnosticsByUri.get(uri) ?? []),
      ];
      try {
        this.callbacks.publishDiagnostics(uri, diagnostics);
        this.publishedDiagnosticUris.add(uri);
      } catch (error) {
        this.log(
          "warning",
          `Unable to publish diagnostics for ${uri}: ${asError(error).message}`,
        );
      }
    }
    for (const uri of [...this.publishedDiagnosticUris]) {
      if (currentUris.has(uri)) {
        continue;
      }
      try {
        this.callbacks.publishDiagnostics(uri, []);
        this.publishedDiagnosticUris.delete(uri);
      } catch (error) {
        this.log(
          "warning",
          `Unable to clear diagnostics for ${uri}: ${asError(error).message}`,
        );
      }
    }
  }

  private findOpenText(path: string): string | undefined {
    const liveText = this.callbacks.getOpenDocument?.(path);
    if (liveText !== undefined) {
      return liveText;
    }
    const own = this.findDocument(path);
    if (own?.editorOpen) {
      return own.text;
    }
    return undefined;
  }

  private getOrCreateDocument(path: string): MutableDocument {
    const existing = this.findDocument(path);
    if (existing) {
      return existing;
    }
    const document: MutableDocument = {
      path: pathKey(path),
      text: "",
      editorOpen: false,
      vfsPaths: new Set<string>(),
    };
    this.documents.set(document.path, document);
    return document;
  }

  private findDocument(path: string): MutableDocument | undefined {
    for (const document of this.documents.values()) {
      if (pathsEqual(document.path, path)) {
        return document;
      }
    }
    return undefined;
  }

  private isReferenced(path: string): boolean {
    if (pathsEqual(path, this.rootPath)) {
      return true;
    }
    for (const input of this.inputFiles.values()) {
      if (pathsEqual(path, input.absolutePath)) {
        return true;
      }
    }
    for (const lookupPath of this.lookupFiles.keys()) {
      if (pathsEqual(path, lookupPath)) {
        return true;
      }
    }
    return false;
  }

  private desiredVfsPaths(document: MutableDocument): Set<string> {
    if (!document.editorOpen && !this.isReferenced(document.path)) {
      return new Set<string>();
    }
    const desired = new Set<string>([document.path]);
    if (pathsEqual(document.path, this.rootPath)) {
      desired.add(this.rootPath);
    }
    for (const input of this.inputFiles.values()) {
      if (pathsEqual(document.path, input.absolutePath)) {
        desired.add(input.absolutePath);
      }
    }
    for (const lookupPath of this.lookupFiles.keys()) {
      if (pathsEqual(document.path, lookupPath)) {
        desired.add(lookupPath);
      }
    }
    return desired;
  }

  private async reconcileDocument(
    document: MutableDocument,
    refreshPaths: readonly string[] = [],
  ): Promise<void> {
    if (!this.child || this.state !== "running") {
      document.vfsPaths.clear();
      this.pruneDocument(document);
      return;
    }
    const desired = this.desiredVfsPaths(document);
    const refresh = new Set(refreshPaths);
    for (const currentPath of [...document.vfsPaths]) {
      if (!desired.has(currentPath)) {
        document.vfsPaths.delete(currentPath);
        await this.sendIfRunning(["close", currentPath]);
      }
    }
    for (const wantedPath of desired) {
      const missing = !document.vfsPaths.has(wantedPath);
      if (missing) {
        document.vfsPaths.add(wantedPath);
      }
      if (missing || refresh.has(wantedPath)) {
        await this.sendIfRunning(["open", wantedPath, document.text]);
      }
    }
    this.pruneDocument(document);
  }

  private reconcileAllDocuments(): void {
    for (const document of this.documents.values()) {
      void this.scheduleReconcile(document);
    }
  }

  private scheduleReconcile(
    document: MutableDocument,
    refreshPaths: readonly string[] = [],
  ): Promise<void> {
    const key = document.path;
    const previous = this.reconcilePromises.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.reconcileDocument(document, refreshPaths));
    this.reconcilePromises.set(key, next);

    const cleanup = (): void => {
      if (this.reconcilePromises.get(key) === next) {
        this.reconcilePromises.delete(key);
      }
    };
    void next.then(cleanup, (error: unknown) => {
      cleanup();
      this.log(
        "warning",
        `Unable to synchronize TeXpresso VFS path ${document.path}: ${asError(error).message}`,
      );
    });
    return next;
  }

  private invalidateVfs(): void {
    for (const document of this.documents.values()) {
      document.vfsPaths.clear();
    }
  }

  private pruneDocument(document: MutableDocument): void {
    if (
      this.documents.get(document.path) === document &&
      !document.editorOpen &&
      !this.isReferenced(document.path) &&
      document.vfsPaths.size === 0
    ) {
      this.documents.delete(document.path);
    }
  }

  private sendIfRunning(message: TeXpressoMessage): Promise<void> {
    if (!this.child || this.state !== "running") {
      return Promise.resolve();
    }
    return this.send(message);
  }

  private send(message: TeXpressoMessage): Promise<void> {
    if (!this.child || this.state !== "running") {
      return Promise.reject(new Error("TeXpresso process is not running"));
    }
    const payload = encodeMessage(message);
    return new Promise<void>((resolveWrite, rejectWrite) => {
      this.writeQueue.push({ payload, resolve: resolveWrite, reject: rejectWrite });
      this.flushWriteQueue();
    });
  }

  private flushWriteQueue(): void {
    if (this.writeScheduled || this.writeBlocked) {
      return;
    }
    this.writeScheduled = true;
    queueMicrotask(() => {
      this.writeScheduled = false;
      const child = this.child;
      if (!child || this.state !== "running") {
        return;
      }
      const stdin = child.stdin;
      while (!this.writeBlocked && this.writeQueue.length > 0) {
        const item = this.writeQueue.shift();
        if (!item) {
          break;
        }
        if (!isWritable(stdin)) {
          const failure = new Error("TeXpresso stdin is closed");
          item.reject(failure);
          this.rejectQueuedWrites(failure);
          this.handleStdinFailure(failure);
          return;
        }
        try {
          this.pendingWrites.add(item);
          const canContinue = stdin.write(item.payload, (error?: Error | null) => {
            if (!this.pendingWrites.delete(item)) {
              return;
            }
            if (error) {
              const failure = asError(error);
              item.reject(failure);
              if (this.child === child) {
                this.handleStdinFailure(failure);
              }
            } else {
              item.resolve();
            }
          });
          if (!canContinue) {
            this.writeBlocked = true;
            return;
          }
        } catch (error) {
          const failure = asError(error, "Unable to write to TeXpresso");
          this.pendingWrites.delete(item);
          item.reject(failure);
          this.handleStdinFailure(failure);
          return;
        }
      }
    });
  }

  private handleStdinFailure(error: Error): void {
    this.processError ??= error;
    this.rejectQueuedWrites(error);
    this.writeBlocked = false;
    this.invalidateVfs();
    this.log("error", `TeXpresso stdin write failed: ${error.message}`);
    const child = this.child;
    if (child && this.state !== "stopping") {
      try {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGTERM");
        }
      } catch {
        // close handler remains responsible for final cleanup.
      }
      if (this.closeTimer && this.closeTimerChild !== child) {
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        this.closeTimerChild = undefined;
      }
      if (!this.closeTimer) {
        const timeout = Math.max(
          0,
          this.settings.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
        );
        this.closeTimer = setTimeout(() => {
          if (this.child !== child || this.closeHandled) {
            return;
          }
          try {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          } catch {
            // The finalizer below still releases waiters and reports the exit.
          }
          setTimeout(() => {
            if (this.child === child && !this.closeHandled) {
              this.finishClose(child, false);
            }
          }, Math.min(250, Math.max(1, timeout))).unref?.();
        }, timeout);
        this.closeTimerChild = child;
        this.closeTimer.unref?.();
      }
    }
  }

  private rejectQueuedWrites(error: Error): void {
    while (this.writeQueue.length > 0) {
      this.writeQueue.shift()?.reject(error);
    }
    for (const item of this.pendingWrites) {
      item.reject(error);
    }
    this.pendingWrites.clear();
  }

  private log(level: number | string, message: string): void {
    if (logPriority(level) > logPriority(this.settings.logLevel ?? "info")) {
      return;
    }
    try {
      this.callbacks.log?.(level, message);
    } catch {
      // Logging must never interfere with process cleanup.
    }
  }
}

function defaultProcessFactory(
  command: string,
  args: readonly string[],
  options: ProcessSpawnOptions,
): TexpressoProcess {
  return spawn(command, [...args], options);
}
