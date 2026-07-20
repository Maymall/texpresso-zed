import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  FileOperationPatternKind,
  MessageType,
  PositionEncodingKind,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  WatchKind,
  type ClientCapabilities,
  type CodeAction,
  type CodeActionParams,
  type ExecuteCommandParams,
  type InitializeParams,
  type InitializeResult,
  type TextDocumentContentChangeEvent,
} from "vscode-languageserver";
import { createConnection } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";

import {
  detectRoot,
  findWorkspaceRootCandidates,
} from "./root-detection.js";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  sameSettings,
  sessionSettings,
  type ServerSettings,
} from "./config.js";
import {
  TexpressoSession,
  type ProcessFactory,
  type SessionCallbacks,
} from "./texpresso-session.js";

export const COMMAND_FORWARD_SYNC = "texpresso-live.forwardSync";
export const COMMAND_NEXT_PAGE = "texpresso-live.nextPage";
export const COMMAND_PREVIOUS_PAGE = "texpresso-live.previousPage";
export const COMMAND_RESCAN = "texpresso-live.rescan";
export const COMMAND_RESTART = "texpresso-live.restart";
export const COMMAND_STOP = "texpresso-live.stop";

const CONTROL_COMMANDS = [
  COMMAND_FORWARD_SYNC,
  COMMAND_NEXT_PAGE,
  COMMAND_PREVIOUS_PAGE,
  COMMAND_RESCAN,
  COMMAND_RESTART,
  COMMAND_STOP,
] as const;

type ControlCommand = (typeof CONTROL_COMMANDS)[number];

interface ControlArguments {
  uri?: string;
  line?: number;
}

interface RootIssue {
  uri: string;
  message: string;
  diagnostic: Diagnostic;
}

interface SessionState {
  token: object;
  rootPath: string;
  session: TexpressoSession;
  diagnostics: Map<string, Diagnostic[]>;
  diagnosticUriAliases: Map<string, string>;
}

interface WorkspaceFolderChangeEvent {
  added: readonly { uri: string }[];
  removed: readonly { uri: string }[];
}

type SettingsSource =
  | "initializationOptions"
  | "workspace/configuration"
  | "didChangeConfiguration";

export interface TexpressoServerOptions {
  /** Test seam; production uses TexpressoSession's normal child-process spawn. */
  processFactory?: ProcessFactory;
}

/**
 * Convert a path to a stable key without requiring it to already exist. The
 * realpath fallback is important for newly-created or overlay-only files.
 */
function canonicalPath(filePath: string): string {
  const absolute = normalize(resolve(filePath));
  let existingAncestor = absolute;
  const suffix: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      return absolute;
    }
    suffix.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    return normalize(join(realpathSync.native(existingAncestor), ...suffix));
  } catch {
    return absolute;
  }
}

function pathFromUri(uri: string): string {
  const parsed = URI.parse(uri);
  return canonicalPath(parsed.scheme === "file" ? parsed.fsPath : parsed.path);
}

function uriForPath(filePath: string): string {
  return URI.file(resolve(filePath)).toString();
}

/** Accept both the protocol's `{ event: ... }` envelope and older clients
 * which sent the workspace-folder event object directly. */
function unwrapWorkspaceFolderChange(
  value: unknown,
): WorkspaceFolderChangeEvent | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate =
    "event" in record && typeof record.event === "object" && record.event !== null
      ? record.event
      : value;
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const event = candidate as Record<string, unknown>;
  if (!Array.isArray(event.added) || !Array.isArray(event.removed)) {
    return undefined;
  }
  const added = event.added.filter(
    (folder): folder is { uri: string } =>
      typeof folder === "object" &&
      folder !== null &&
      typeof (folder as { uri?: unknown }).uri === "string",
  );
  const removed = event.removed.filter(
    (folder): folder is { uri: string } =>
      typeof folder === "object" &&
      folder !== null &&
      typeof (folder as { uri?: unknown }).uri === "string",
  );
  return { added, removed };
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function pathIsWithin(candidate: string, parent: string): boolean {
  const difference = relative(canonicalPath(parent), canonicalPath(candidate));
  return (
    difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}

function asControlArguments(value: unknown): ControlArguments {
  if (typeof value === "string") {
    return { uri: value };
  }
  if (Array.isArray(value)) {
    return asControlArguments(value[0]);
  }
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const uri = typeof record.uri === "string" ? record.uri : undefined;
  const line = typeof record.line === "number" && Number.isFinite(record.line) ? record.line : undefined;
  return {
    ...(uri === undefined ? {} : { uri }),
    ...(line === undefined ? {} : { line }),
  };
}

function diagnosticsForRootIssue(
  message: string,
  severity: DiagnosticSeverity,
): Diagnostic {
  return {
    severity,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    message,
    source: "texpresso",
    code: "root-file",
  };
}

function normalizeDiagnosticUri(value: string, rootPath: string): string {
  if (value.startsWith("file:")) {
    return uriForPath(pathFromUri(value));
  }
  return uriForPath(isAbsolute(value) ? value : resolve(dirname(rootPath), value));
}

function messageLevel(
  level: MessageType | number | string,
  message: string,
  connection: ReturnType<typeof createConnection>,
): void {
  const normalized =
    typeof level === "string" ? level.toLowerCase() : level;
  switch (normalized) {
    case MessageType.Error:
    case "error":
      connection.console.error(message);
      break;
    case MessageType.Warning:
    case "warn":
    case "warning":
      connection.console.warn(message);
      break;
    case MessageType.Info:
    case "info":
      connection.console.info(message);
      break;
    default:
      connection.console.log(message);
      break;
  }
}

/**
 * Install the language server. Keeping this in a function makes the module
 * straightforward to embed in a test process while the normal entry point
 * still starts immediately at the bottom of this file.
 */
export function createTexpressoServer(
  input = process.stdin,
  output = process.stdout,
  options: TexpressoServerOptions = {},
): ReturnType<typeof createConnection> {
  // Passing streams explicitly selects stdio and avoids relying on a command
  // line `--stdio` flag, which Zed does not add to extension commands.
  const connection = createConnection(ProposedFeatures.all, input, output);

  let clientCapabilities: ClientCapabilities = {};
  let workspaceFolders: string[] = [];
  let settings: ServerSettings = { ...DEFAULT_SETTINGS };
  let initialized = false;
  let shuttingDown = false;
  let watcherRegistrationStarted = false;
  let workspaceFolderListenerStarted = false;
  let workspaceRootCandidates: readonly string[] | undefined;
  let initialWorkspaceConfigurationRequested = false;
  let resolveInitialSettings: (() => void) | undefined;
  let initialSettingsReady: Promise<void> = Promise.resolve();

  const sessions = new Map<string, SessionState>();
  const rootIssues = new Map<string, RootIssue>();
  const documentQueues = new Map<string, Promise<void>>();
  const documentGenerations = new Map<string, number>();
  const syncedGenerations = new Map<string, number>();
  const manuallyStoppedRoots = new Set<string>();
  const removedRoots = new Set<string>();
  const knownRoots = new Set<string>();
  let lifecycleQueue: Promise<void> = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;

  function enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const run = lifecycleQueue.then(task, task);
    lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function logSettings(source: SettingsSource, value: ServerSettings): void {
    log(
      MessageType.Debug,
      `Applied TeXpresso settings from ${source}; command=${JSON.stringify(value.command)}.`,
    );
  }

  function beginInitialWorkspaceConfiguration(): void {
    initialWorkspaceConfigurationRequested = true;
    initialSettingsReady = new Promise<void>((resolveInitialSettingsPromise) => {
      resolveInitialSettings = resolveInitialSettingsPromise;
    });
  }

  function finishInitialWorkspaceConfiguration(): void {
    const resolveInitialSettingsPromise = resolveInitialSettings;
    resolveInitialSettings = undefined;
    resolveInitialSettingsPromise?.();
  }

  // TextDocuments owns the canonical in-memory text. Its update hook gives us
  // the original incremental ranges before they are applied, so change-range
  // remains UTF-16/LSP-compatible instead of degrading to full-text opens.
  const documents = new TextDocuments<TextDocument>({
    create: TextDocument.create,
    update: (document, changes, version) => {
      const generation = nextDocumentGeneration(document.uri);
      enqueueAfterInitialSettings(document.uri, () =>
        handleChanges(document.uri, changes, generation),
      );
      return TextDocument.update(document, changes, version);
    },
  });

  function nextDocumentGeneration(uri: string): number {
    const next = (documentGenerations.get(uri) ?? 0) + 1;
    documentGenerations.set(uri, next);
    return next;
  }

  function sessionDocumentKey(state: SessionState, filePath: string): string {
    return `${state.rootPath}\0${canonicalPath(filePath)}`;
  }

  function markSynced(
    state: SessionState,
    filePath: string,
    generation: number,
  ): void {
    if (sessions.get(state.rootPath) !== state) {
      return;
    }
    syncedGenerations.set(sessionDocumentKey(state, filePath), generation);
  }

  function clearSyncedForRoot(rootPath: string): void {
    const prefix = `${canonicalPath(rootPath)}\0`;
    for (const key of syncedGenerations.keys()) {
      if (key.startsWith(prefix)) {
        syncedGenerations.delete(key);
      }
    }
  }

  function allOpenDocuments(): TextDocument[] {
    return documents.all();
  }

  function cachedWorkspaceRootCandidates(): readonly string[] {
    workspaceRootCandidates ??=
      findWorkspaceRootCandidates(workspaceFolders);
    return workspaceRootCandidates;
  }

  function invalidateWorkspaceRootCandidates(): void {
    workspaceRootCandidates = undefined;
  }

  function openDocumentText(filePath: string): string | undefined {
    for (const document of allOpenDocuments()) {
      if (samePath(pathFromUri(document.uri), filePath)) {
        return document.getText();
      }
    }
    return undefined;
  }

  async function drainDocumentQueues(): Promise<void> {
    while (documentQueues.size > 0) {
      await Promise.all([...documentQueues.values()]);
    }
  }

  /**
   * Permanently gate current sessions before draining work. This both unblocks
   * pending starts/writes and prevents an in-flight restart from creating a
   * replacement child after the session map is cleared.
   */
  function shutdownSessions(): Promise<void> {
    shuttingDown = true;
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      await stopAll(true);
      await lifecycleQueue;
      await drainDocumentQueues();
      // A document task can enqueue lifecycle work while it is draining. Take
      // one more snapshot before stopping, then repeat cleanup defensively.
      await lifecycleQueue;
      await drainDocumentQueues();
      await stopAll(true);
    })();
    return shutdownPromise;
  }

  function publishCombined(uri: string): void {
    const diagnostics: Diagnostic[] = [];
    for (const state of sessions.values()) {
      const sessionDiagnostics = state.diagnostics.get(uri);
      if (sessionDiagnostics) {
        diagnostics.push(...sessionDiagnostics);
      }
    }
    const issue = rootIssues.get(uri);
    if (issue) {
      diagnostics.push(issue.diagnostic);
    }
    void connection.sendDiagnostics({ uri, diagnostics });
  }

  function setRootIssue(
    uri: string,
    message: string,
    severity: DiagnosticSeverity = DiagnosticSeverity.Warning,
  ): void {
    rootIssues.set(uri, {
      uri,
      message,
      diagnostic: diagnosticsForRootIssue(message, severity),
    });
    publishCombined(uri);
  }

  function clearRootIssue(uri: string): void {
    if (rootIssues.delete(uri)) {
      publishCombined(uri);
    }
  }

  function log(level: MessageType | number | string, message: string): void {
    messageLevel(level, message, connection);
  }

  async function showDocument(filePath: string, line: number): Promise<void> {
    if (clientCapabilities.window?.showDocument?.support !== true) {
      log(
        MessageType.Warning,
        `TeXpresso requested backward SyncTeX for ${filePath}:${line + 1}, but this LSP client does not support window/showDocument.`,
      );
      return;
    }

    const uri = uriForPath(filePath);
    try {
      const result = await connection.window.showDocument({
        uri,
        external: false,
        takeFocus: true,
        selection: {
          start: { line: Math.max(0, Math.floor(line)), character: 0 },
          end: { line: Math.max(0, Math.floor(line)), character: 0 },
        },
      });
      if (!result.success) {
        log(MessageType.Warning, `The client could not open the TeXpresso SyncTeX target ${uri}.`);
      }
    } catch (error) {
      log(MessageType.Warning, `window/showDocument failed for ${uri}: ${String(error)}`);
    }
  }

  function callbackFor(rootPath: string, token: object): SessionCallbacks {
    return {
      publishDiagnostics: (documentUri, diagnostics) => {
        const state = sessions.get(canonicalPath(rootPath));
        if (!state || state.token !== token) {
          return;
        }
        const normalizedUri = normalizeDiagnosticUri(documentUri, rootPath);
        let uri = state.diagnosticUriAliases.get(normalizedUri);
        if (!uri) {
          const diagnosticPath = pathFromUri(normalizedUri);
          uri =
            allOpenDocuments().find((document) =>
              samePath(pathFromUri(document.uri), diagnosticPath),
            )?.uri ?? normalizedUri;
        }
        if (diagnostics.length > 0) {
          state.diagnosticUriAliases.set(normalizedUri, uri);
        } else {
          state.diagnosticUriAliases.delete(normalizedUri);
        }
        state.diagnostics.set(uri, diagnostics);
        publishCombined(uri);
        if (diagnostics.length === 0) {
          state.diagnostics.delete(uri);
        }
      },
      showDocument,
      log,
      getOpenDocument: openDocumentText,
      exited: (error) => {
        const key = canonicalPath(rootPath);
        const state = sessions.get(key);
        if (!state || state.token !== token) {
          return;
        }
        clearSyncedForRoot(key);
        sessions.delete(key);
        const affectedUris = [...state.diagnostics.keys()];
        state.diagnostics.clear();
        state.diagnosticUriAliases.clear();
        for (const uri of affectedUris) {
          publishCombined(uri);
        }
        if (error && !shuttingDown) {
          const rootUri = uriForPath(rootPath);
          setRootIssue(
            rootUri,
            `TeXpresso stopped unexpectedly for ${rootPath}: ${error.message}. Check the TeXpresso command and logs.`,
          );
        }
      },
    };
  }

  async function stopState(
    state: SessionState,
    terminal = false,
  ): Promise<void> {
    try {
      await (terminal ? state.session.shutdown() : state.session.stop());
    } catch (error) {
      log(MessageType.Warning, `Failed to stop TeXpresso for ${state.rootPath}: ${String(error)}`);
    }
    const affectedUris = [...state.diagnostics.keys()];
    state.diagnostics.clear();
    state.diagnosticUriAliases.clear();
    for (const uri of affectedUris) {
      publishCombined(uri);
    }
  }

  async function stopAll(terminal = false): Promise<void> {
    const states = [...sessions.values()];
    sessions.clear();
    syncedGenerations.clear();
    await Promise.all(states.map((state) => stopState(state, terminal)));
  }

  async function ensureSession(rootPath: string, forceStart = false): Promise<SessionState | undefined> {
    const key = canonicalPath(rootPath);
    knownRoots.add(key);
    if (shuttingDown) {
      return undefined;
    }
    if (forceStart) {
      manuallyStoppedRoots.delete(key);
      removedRoots.delete(key);
    }
    const existing = sessions.get(key);
    if (existing) {
      if (!forceStart && manuallyStoppedRoots.has(key)) {
        return undefined;
      }
      const wasRunning = existing.session.running;
      try {
        await existing.session.start();
      } catch (error) {
        const ownsSlot = sessions.get(key) === existing;
        if (ownsSlot) {
          sessions.delete(key);
          clearSyncedForRoot(key);
        }
        await stopState(existing);
        if (!ownsSlot) {
          return undefined;
        }
        const message = `Could not start TeXpresso (${settings.command}) for ${key}: ${String(error)}. Set texpressoCommand to an executable path or install TeXpresso.`;
        setRootIssue(uriForPath(key), message, DiagnosticSeverity.Error);
        log(MessageType.Error, message);
        return undefined;
      }
      if (!wasRunning) {
        clearSyncedForRoot(key);
      }
      return existing;
    }
    if (
      (!forceStart && !settings.autoStart) ||
      (!forceStart && manuallyStoppedRoots.has(key)) ||
      (!forceStart && removedRoots.has(key))
    ) {
      return undefined;
    }

    const token = {};
    const session = new TexpressoSession(
      key,
      sessionSettings(settings),
      callbackFor(key, token),
      options.processFactory,
    );
    const state: SessionState = {
      token,
      rootPath: key,
      session,
      diagnostics: new Map(),
      diagnosticUriAliases: new Map(),
    };
    clearSyncedForRoot(key);
    sessions.set(key, state);
    try {
      await session.start();
      clearRootIssue(uriForPath(key));
      // The root is always known at this point. Other open buffers are sent
      // when TeXpresso announces them through input-file/getOpenDocument.
      const rootDocument = allOpenDocuments().find((document) => samePath(pathFromUri(document.uri), key));
      if (rootDocument) {
        await session.openDocument(key, rootDocument.getText());
        markSynced(
          state,
          key,
          documentGenerations.get(rootDocument.uri) ?? 0,
        );
      }
      return state;
    } catch (error) {
      const ownsSlot = sessions.get(key) === state;
      if (ownsSlot) {
        sessions.delete(key);
      }
      await stopState(state);
      if (!ownsSlot) {
        return undefined;
      }
      const message = `Could not start TeXpresso (${settings.command}) for ${key}: ${String(error)}. Set texpressoCommand to an executable path or install TeXpresso.`;
      setRootIssue(uriForPath(key), message, DiagnosticSeverity.Error);
      log(MessageType.Error, message);
      return undefined;
    }
  }

  function sessionStatesForDocument(filePath: string): SessionState[] {
    return [...sessions.values()].filter(
      (state) =>
        state.session.ownsPath(filePath) || state.session.tracksPath(filePath),
    );
  }

  async function detectRootFor(document: TextDocument): Promise<string | undefined> {
    const documentPath = pathFromUri(document.uri);
    const result = await detectRoot({
      documentPath,
      documentText: document.getText(),
      workspaceFolders,
      workspaceCandidatesProvider: cachedWorkspaceRootCandidates,
      ...(settings.rootFile === undefined
        ? {}
        : { configuredRoot: settings.rootFile }),
    });
    if (result.found) {
      clearRootIssue(document.uri);
      const rootPath = canonicalPath(result.rootPath);
      knownRoots.add(rootPath);
      return rootPath;
    }
    setRootIssue(
      document.uri,
      `TeXpresso could not determine a root document for ${documentPath}: ${result.reason}. Set "rootFile" in lsp.texpresso-live.settings or add % !TEX root = path/to/main.tex.`,
    );
    log(MessageType.Warning, result.reason);
    return undefined;
  }

  async function ensureForDocument(document: TextDocument, forceStart = false): Promise<SessionState[]> {
    if (shuttingDown) {
      return [];
    }
    const filePath = pathFromUri(document.uri);
    const existing = sessionStatesForDocument(filePath);
    if (existing.length > 0) {
      const ready: SessionState[] = [];
      for (const state of existing) {
        const ensured = await ensureSession(state.rootPath, forceStart);
        if (ensured) {
          ready.push(ensured);
        }
      }
      return ready;
    }
    const rootPath = await detectRootFor(document);
    if (!rootPath) {
      return [];
    }
    const state = await ensureSession(rootPath, forceStart);
    if (!state) {
      const rootIssue = rootIssues.get(uriForPath(rootPath));
      if (rootIssue && !samePath(rootPath, filePath)) {
        setRootIssue(
          document.uri,
          rootIssue.message,
          rootIssue.diagnostic.severity ?? DiagnosticSeverity.Error,
        );
      }
    }
    return state ? [state] : [];
  }

  function enqueue(uri: string, task: () => Promise<void>): void {
    const previous = documentQueues.get(uri) ?? Promise.resolve();
    const next = previous.then(task, task).catch((error) => {
      log(MessageType.Error, `TeXpresso document synchronization failed for ${uri}: ${String(error)}`);
    });
    documentQueues.set(uri, next);
    void next.finally(() => {
      if (documentQueues.get(uri) === next) {
        documentQueues.delete(uri);
      }
    });
  }

  /**
   * A client may send didOpen immediately after initialized. Zed's configured
   * LSP settings arrive through a separate workspace/configuration request,
   * so do not let an open or change enter the document queue until that first
   * request has completed. Waiting here, rather than from a queued task,
   * avoids a cycle with applySettings' lifecycle queue.
   */
  function enqueueAfterInitialSettings(
    uri: string,
    task: () => Promise<void>,
  ): void {
    void initialSettingsReady.then(() => {
      enqueue(uri, task);
    });
  }

  async function handleOpen(
    document: TextDocument,
    generation: number,
  ): Promise<void> {
    if (shuttingDown) {
      return;
    }
    const states = await ensureForDocument(document);
    const latestDocument = documents.get(document.uri);
    if (!latestDocument) {
      return;
    }
    const filePath = pathFromUri(latestDocument.uri);
    const latestGeneration = documentGenerations.get(document.uri) ?? generation;
    for (const state of states) {
      if (
        syncedGenerations.get(sessionDocumentKey(state, filePath)) ===
        latestGeneration
      ) {
        continue;
      }
      await state.session.openDocument(filePath, latestDocument.getText());
      markSynced(state, filePath, latestGeneration);
    }
  }

  async function handleChanges(
    uri: string,
    changes: readonly TextDocumentContentChangeEvent[],
    generation: number,
  ): Promise<void> {
    if (shuttingDown) {
      return;
    }
    const document = documents.get(uri);
    if (!document) {
      return;
    }
    const filePath = pathFromUri(uri);
    const states = await ensureForDocument(document);
    const latestDocument = documents.get(uri);
    if (!latestDocument) {
      return;
    }
    const currentGeneration = documentGenerations.get(uri) ?? generation;
    for (const state of states) {
      const syncKey = sessionDocumentKey(state, filePath);
      const syncedGeneration = syncedGenerations.get(syncKey);
      if (
        syncedGeneration !== undefined &&
        generation <= syncedGeneration
      ) {
        continue;
      }

      // Recovery can take long enough for several changes to queue. An
      // unsynchronized document receives the latest full snapshot once;
      // marking that generation prevents historical ranges from replaying.
      if (syncedGeneration === undefined) {
        await state.session.openDocument(filePath, latestDocument.getText());
        markSynced(state, filePath, currentGeneration);
        continue;
      }

      if (currentGeneration > generation) {
        await state.session.openDocument(filePath, latestDocument.getText());
        markSynced(state, filePath, currentGeneration);
        continue;
      }

      for (const change of changes) {
        await state.session.changeDocument(
          filePath,
          "range" in change
            ? { range: change.range, text: change.text }
            : { text: change.text },
        );
      }
      markSynced(state, filePath, generation);
    }
  }

  async function handleClose(document: TextDocument): Promise<void> {
    const filePath = pathFromUri(document.uri);
    for (const state of sessions.values()) {
      await state.session.closeDocument(filePath);
      syncedGenerations.delete(sessionDocumentKey(state, filePath));
    }
    clearRootIssue(document.uri);
  }

  async function stopAndForget(
    state: SessionState,
    manual: boolean,
  ): Promise<void> {
    if (sessions.get(state.rootPath) === state) {
      sessions.delete(state.rootPath);
      clearSyncedForRoot(state.rootPath);
      if (manual) {
        manuallyStoppedRoots.add(state.rootPath);
      }
      clearRootIssue(uriForPath(state.rootPath));
    }
    await stopState(state);
  }

  function clearRootIssuesAtOrBelow(paths: readonly string[]): void {
    for (const uri of [...rootIssues.keys()]) {
      try {
        const issuePath = pathFromUri(uri);
        if (paths.some((changedPath) => pathIsWithin(issuePath, changedPath))) {
          clearRootIssue(uri);
        }
      } catch {
        // Root issues are normally file URIs. Ignore a foreign URI rather
        // than letting one client-provided value break lifecycle cleanup.
      }
    }
  }

  async function handleRemovedPathsInternal(paths: readonly string[]): Promise<void> {
    invalidateWorkspaceRootCandidates();
    clearRootIssuesAtOrBelow(paths);
    for (const root of new Set([
      ...sessions.keys(),
      ...manuallyStoppedRoots,
      ...knownRoots,
    ])) {
      if (paths.some((changedPath) => pathIsWithin(root, changedPath))) {
        removedRoots.add(root);
      }
    }

    for (const state of [...sessions.values()]) {
      if (paths.some((changedPath) => pathIsWithin(state.rootPath, changedPath))) {
        await stopAndForget(state, false);
        removedRoots.add(state.rootPath);
        continue;
      }
      if (
        paths.some(
          (changedPath) =>
            state.session.tracksPathAtOrBelow(changedPath),
        )
      ) {
        try {
          await state.session.rescan();
        } catch (error) {
          log(
            MessageType.Warning,
            `Could not rescan TeXpresso after a file operation: ${String(error)}`,
          );
        }
      }
    }
  }

  function handleRemovedPaths(paths: readonly string[]): Promise<void> {
    return enqueueLifecycle(() => handleRemovedPathsInternal(paths));
  }

  function handleWatchedFileChanges(
    changes: readonly { uri: string; type: number }[],
  ): Promise<void> {
    return enqueueLifecycle(async () => {
      if (changes.length > 0) {
        invalidateWorkspaceRootCandidates();
      }
      const restoredRoots = new Set<string>();
      // Preserve notification order so an atomic delete/create replacement
      // does not leave a tombstone after the recreated root is visible.
      for (const change of changes) {
        const changedPath = pathFromUri(change.uri);
        if (change.type === FileChangeType.Deleted) {
          await handleRemovedPathsInternal([changedPath]);
        } else {
          const canonicalChangedPath = canonicalPath(changedPath);
          for (const root of [...removedRoots]) {
            // A file change restores only that root; a directory recreation
            // may restore roots nested below it. An unrelated sibling change
            // must not revive a deleted workspace.
            if (pathIsWithin(root, canonicalChangedPath)) {
              removedRoots.delete(root);
              restoredRoots.add(root);
            }
          }
        }
      }
      if (restoredRoots.size > 0 && settings.autoStart) {
        for (const document of allOpenDocuments()) {
          const root = await detectRootFor(document);
          if (root && restoredRoots.has(canonicalPath(root))) {
            await handleOpen(document, documentGenerations.get(document.uri) ?? 0);
          }
        }
      }
    });
  }

  async function handleWorkspaceFoldersChangedInternal(event: {
    added: readonly { uri: string }[];
    removed: readonly { uri: string }[];
  }): Promise<void> {
    invalidateWorkspaceRootCandidates();
    const removed = event.removed.map((folder) => pathFromUri(folder.uri));
    const added = event.added.map((folder) => pathFromUri(folder.uri));
    const removedSet = new Set(removed.map(canonicalPath));
    workspaceFolders = workspaceFolders.filter(
      (folder) => !removedSet.has(canonicalPath(folder)),
    );
    for (const addedFolder of added) {
      if (!workspaceFolders.some((current) => samePath(current, addedFolder))) {
        workspaceFolders.push(addedFolder);
      }
    }
    await handleRemovedPathsInternal(removed);
    for (const addedFolder of added) {
      for (const root of [...removedRoots]) {
        if (pathIsWithin(root, addedFolder)) {
          removedRoots.delete(root);
        }
      }
      if (settings.autoStart) {
        for (const document of allOpenDocuments()) {
          if (pathIsWithin(pathFromUri(document.uri), addedFolder)) {
            await handleOpen(
              document,
              documentGenerations.get(document.uri) ?? 0,
            );
          }
        }
      }
    }
  }

  function handleWorkspaceFoldersChanged(event: {
    added: readonly { uri: string }[];
    removed: readonly { uri: string }[];
  }): Promise<void> {
    return enqueueLifecycle(() => handleWorkspaceFoldersChangedInternal(event));
  }

  function argsForAction(uri: string, line: number): { arguments: ControlArguments[] } {
    return { arguments: [{ uri, line }] };
  }

  function action(title: string, command: ControlCommand, params: CodeActionParams): CodeAction {
    return {
      title,
      kind: CodeActionKind.Source,
      command: {
        title,
        command,
        ...argsForAction(params.textDocument.uri, params.range.start.line),
      },
    };
  }

  async function controlInternal(command: ControlCommand, raw: unknown): Promise<null> {
    if (shuttingDown) {
      return null;
    }
    const args = asControlArguments(raw);
    const document = args.uri ? documents.get(args.uri) : undefined;
    const runningBefore = new Set(
      [...sessions.values()]
        .filter((state) => state.session.running)
        .map((state) => state.rootPath),
    );
    let states: SessionState[];
    if (command === COMMAND_STOP && document) {
      const filePath = pathFromUri(document.uri);
      states = sessionStatesForDocument(filePath);
      if (states.length === 0) {
        const rootPath = await detectRootFor(document);
        const state = rootPath ? sessions.get(rootPath) : undefined;
        states = state ? [state] : [];
      }
    } else if (document) {
      states = await ensureForDocument(document, command === COMMAND_RESTART || command === COMMAND_RESCAN);
    } else {
      states = [...sessions.values()];
    }

    const line = Math.max(0, Math.floor(args.line ?? 0));
    const uriPath = args.uri ? pathFromUri(args.uri) : undefined;
    for (const state of states) {
      if (shuttingDown) {
        break;
      }
      switch (command) {
        case COMMAND_FORWARD_SYNC:
          if (uriPath) {
            await state.session.forwardSync(uriPath, line);
          }
          break;
        case COMMAND_NEXT_PAGE:
          await state.session.nextPage();
          break;
        case COMMAND_PREVIOUS_PAGE:
          await state.session.previousPage();
          break;
        case COMMAND_RESCAN:
          await state.session.rescan();
          break;
        case COMMAND_RESTART:
          if (!runningBefore.has(state.rootPath)) {
            clearRootIssue(uriForPath(state.rootPath));
            break;
          }
          try {
            await state.session.restart(sessionSettings(settings));
            clearRootIssue(uriForPath(state.rootPath));
          } catch (error) {
            await stopAndForget(state, false);
            if (shuttingDown) {
              break;
            }
            const message = `Could not restart TeXpresso (${settings.command}) for ${state.rootPath}: ${String(error)}. Check texpressoCommand and the TeXpresso logs.`;
            setRootIssue(
              uriForPath(state.rootPath),
              message,
              DiagnosticSeverity.Error,
            );
            log(MessageType.Error, message);
          }
          break;
        case COMMAND_STOP:
          await stopAndForget(state, true);
          break;
      }
    }
    return null;
  }

  function control(command: ControlCommand, raw: unknown): Promise<null> {
    return enqueueLifecycle(() => controlInternal(command, raw));
  }

  async function applySettingsInternal(
    value: unknown,
    source: SettingsSource,
  ): Promise<void> {
    if (shuttingDown) {
      return;
    }
    const next = parseSettings(value);
    logSettings(source, next);
    if (sameSettings(settings, next)) {
      return;
    }
    settings = next;
    manuallyStoppedRoots.clear();
    removedRoots.clear();
    for (const uri of [...rootIssues.keys()]) {
      clearRootIssue(uri);
    }
    await stopAll(true);
    if (!settings.autoStart) {
      return;
    }
    for (const document of allOpenDocuments()) {
      await ensureForDocument(document);
    }
  }

  function applySettings(
    value: unknown,
    source: SettingsSource,
  ): Promise<void> {
    return enqueueLifecycle(() => applySettingsInternal(value, source));
  }

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    clientCapabilities = params.capabilities;
    workspaceFolders =
      params.workspaceFolders?.map((folder) => canonicalPath(URI.parse(folder.uri).fsPath)) ?? [];
    if (workspaceFolders.length === 0 && params.rootUri) {
      workspaceFolders = [canonicalPath(URI.parse(params.rootUri).fsPath)];
    }
    settings = parseSettings(params.initializationOptions);
    logSettings("initializationOptions", settings);
    if (params.capabilities.workspace?.configuration === true) {
      beginInitialWorkspaceConfiguration();
    }
    initialized = true;
    // WorkspaceFoldersFeature installs its own raw handler during initialize.
    // Register after that feature has initialized so this single handler owns
    // the notification and can accept both protocol and legacy payloads.
    if (
      params.capabilities.workspace?.workspaceFolders === true &&
      !workspaceFolderListenerStarted
    ) {
      workspaceFolderListenerStarted = true;
      connection.onNotification(
        "workspace/didChangeWorkspaceFolders",
        (raw: unknown) => {
          const event = unwrapWorkspaceFolderChange(raw);
          if (!event) {
            log(
              MessageType.Warning,
              "Ignoring malformed workspace/didChangeWorkspaceFolders notification.",
            );
            return;
          }
          void handleWorkspaceFoldersChanged(event).catch((error) =>
            log(
              MessageType.Warning,
              `Could not process workspace folder changes: ${String(error)}`,
            ),
          );
        },
      );
    }
    return {
      capabilities: {
        positionEncoding: PositionEncodingKind.UTF16,
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Incremental,
        },
        codeActionProvider: { codeActionKinds: [CodeActionKind.Source] },
        executeCommandProvider: { commands: [...CONTROL_COMMANDS] },
        workspace: {
          workspaceFolders: {
            supported: true,
            changeNotifications: true,
          },
          fileOperations: {
            didRename: {
              filters: [
                {
                  scheme: "file",
                  pattern: {
                    glob: "**/*.tex",
                    matches: FileOperationPatternKind.file,
                  },
                },
                {
                  scheme: "file",
                  pattern: {
                    glob: "**",
                    matches: FileOperationPatternKind.folder,
                  },
                },
              ],
            },
            didDelete: {
              filters: [
                {
                  scheme: "file",
                  pattern: {
                    glob: "**/*.tex",
                    matches: FileOperationPatternKind.file,
                  },
                },
                {
                  scheme: "file",
                  pattern: {
                    glob: "**",
                    matches: FileOperationPatternKind.folder,
                  },
                },
              ],
            },
          },
        },
      },
      serverInfo: { name: "texpresso-live", version: "0.1.1" },
    };
  });

  connection.onInitialized(() => {
    if (!initialized) {
      return;
    }
    if (initialWorkspaceConfigurationRequested) {
      void (async () => {
        try {
          const value = await connection.workspace.getConfiguration("texpresso-live");
          await applySettings(value, "workspace/configuration");
        } catch (error) {
          log(
            MessageType.Warning,
            `Could not read TeXpresso workspace settings; using initializationOptions: ${String(error)}`,
          );
        } finally {
          finishInitialWorkspaceConfiguration();
        }
      })();
    }
    if (
      clientCapabilities.workspace?.didChangeWatchedFiles
        ?.dynamicRegistration === true &&
      !watcherRegistrationStarted
    ) {
      watcherRegistrationStarted = true;
      void connection.client
        .register(DidChangeWatchedFilesNotification.type, {
          watchers: [
            {
              globPattern: "**/*.tex",
              kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
            },
          ],
        })
        .catch((error) => {
          watcherRegistrationStarted = false;
          log(
            MessageType.Warning,
            `Could not register TeX file deletion notifications: ${String(error)}`,
          );
        });
    }
  });

  connection.onDidChangeConfiguration((params) => {
    void applySettings(params.settings, "didChangeConfiguration");
  });

  connection.onNotification("workspace/didRenameFiles", (params: {
    files: readonly { oldUri: string; newUri: string }[];
  }) => {
    void handleRemovedPaths(
      params.files.map((file) => pathFromUri(file.oldUri)),
    ).catch((error) =>
      log(MessageType.Warning, `Could not process TeX file rename: ${String(error)}`),
    );
  });

  connection.onNotification("workspace/didDeleteFiles", (params: {
    files: readonly { uri: string }[];
  }) => {
    void handleRemovedPaths(
      params.files.map((file) => pathFromUri(file.uri)),
    ).catch((error) =>
      log(MessageType.Warning, `Could not process TeX file deletion: ${String(error)}`),
    );
  });

  connection.onDidChangeWatchedFiles((params) => {
    void handleWatchedFileChanges(params.changes).catch((error) =>
      log(
        MessageType.Warning,
        `Could not process watched TeX file changes: ${String(error)}`,
      ),
    );
  });

  connection.onCodeAction((params: CodeActionParams): CodeAction[] => [
    action("Sync TeXpresso preview here", COMMAND_FORWARD_SYNC, params),
    action("TeXpresso: next page", COMMAND_NEXT_PAGE, params),
    action("TeXpresso: previous page", COMMAND_PREVIOUS_PAGE, params),
    action("TeXpresso: rescan", COMMAND_RESCAN, params),
    action("TeXpresso: restart", COMMAND_RESTART, params),
    action("TeXpresso: stop", COMMAND_STOP, params),
  ]);

  connection.onExecuteCommand((params: ExecuteCommandParams) => {
    const command = CONTROL_COMMANDS.includes(params.command as ControlCommand)
      ? (params.command as ControlCommand)
      : undefined;
    if (!command) {
      log(MessageType.Warning, `Unknown TeXpresso command: ${params.command}`);
      return null;
    }
    return control(command, params.arguments?.[0]);
  });

  documents.onDidOpen((event) => {
    const generation = nextDocumentGeneration(event.document.uri);
    // An explicit open is a user-visible recreation signal for this exact
    // path. Do this synchronously, before its queued synchronization work, so
    // a later delete notification cannot be undone by an older didOpen task.
    removedRoots.delete(canonicalPath(pathFromUri(event.document.uri)));
    enqueueAfterInitialSettings(event.document.uri, () =>
      handleOpen(event.document, generation),
    );
  });
  documents.onDidClose((event) =>
    enqueueAfterInitialSettings(event.document.uri, () => handleClose(event.document)),
  );
  documents.listen(connection);

  connection.onShutdown(async () => {
    await shutdownSessions();
  });
  connection.onExit(() => {
    // Session.stop installs its own child-process cleanup; this best-effort
    // call also covers clients that send exit without a shutdown request.
    void shutdownSessions();
  });

  return connection;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createTexpressoServer();
  server.listen();
}
