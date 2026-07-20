import path from "node:path";
import { fileURLToPath } from "node:url";

import { URI } from "vscode-uri";

export type DiagnosticChannel = "out" | "log";

/** LSP DiagnosticSeverity numeric values. */
export enum AdapterDiagnosticSeverity {
  Error = 1,
  Warning = 2,
}

export interface AdapterPosition {
  readonly line: number;
  readonly character: number;
}

export interface AdapterRange {
  readonly start: AdapterPosition;
  readonly end: AdapterPosition;
}

/** Structurally compatible with vscode-languageserver's Diagnostic type. */
export interface AdapterDiagnostic {
  readonly range: AdapterRange;
  readonly severity: AdapterDiagnosticSeverity;
  readonly message: string;
  readonly source: "texpresso";
}

export interface LocatedDiagnostic {
  readonly uri: string;
  readonly diagnostic: AdapterDiagnostic;
}

export interface DiagnosticStateOptions {
  /** Absolute path to the session's root TeX document. */
  readonly rootPath?: string;
  /** Explicit directory used to resolve relative diagnostic paths. */
  readonly baseDirectory?: string;
  /** Show Overfull/Underfull box warnings (false by default). */
  readonly showBoxWarnings?: boolean;
}

export type ParseDiagnosticOptions = DiagnosticStateOptions;

export interface DiagnosticFlushResult {
  /** Current diagnostics, grouped for textDocument/publishDiagnostics. */
  readonly byUri: ReadonlyMap<string, readonly AdapterDiagnostic[]>;
  /** Descriptive alias for byUri. */
  readonly diagnosticsByUri: ReadonlyMap<string, readonly AdapterDiagnostic[]>;
  /** Flat form useful in tests and logging. */
  readonly diagnostics: readonly LocatedDiagnostic[];
  /** URIs which had diagnostics on the previous flush but no longer do. */
  readonly urisToClear: readonly string[];
  /** Non-empty lines from the TeXpresso log plus unparsed output lines. */
  readonly logLines: readonly string[];
  /** Output lines which were not valid positioned error/warning records. */
  readonly unparsedLines: readonly string[];
  /** Snapshot of the current output buffer. */
  readonly outLines: readonly string[];
}

/**
 * Mutable `out`/`log` state for TeXpresso's append/truncate/flush protocol.
 * Diagnostics are derived only at flush boundaries.
 */
export class DiagnosticState {
  private outBuffer = "";
  private logBuffer = "";
  private emittedOutBuffer = "";
  private emittedLogBuffer = "";
  /** Diagnostic-shaped output which ended mid-line at the previous flush. */
  private pendingDiagnosticLine = "";
  private publishedUris = new Set<string>();
  private readonly options: DiagnosticStateOptions;

  public constructor(options: DiagnosticStateOptions | string = {}) {
    this.options =
      typeof options === "string" ? { rootPath: options } : options;
  }

  public get out(): string {
    return this.outBuffer;
  }

  public get log(): string {
    return this.logBuffer;
  }

  public get outLines(): readonly string[] {
    return splitBufferLines(this.outBuffer);
  }

  public get logLines(): readonly string[] {
    return splitBufferLines(this.logBuffer);
  }

  /** Append legacy byte/chunk output. */
  public append(channel: DiagnosticChannel, text: string): void {
    const buffer = this.getBuffer(channel);
    this.setBuffer(channel, buffer + text);
  }

  public appendLines(channel: DiagnosticChannel, lines: readonly string[]): void;
  public appendLines(channel: DiagnosticChannel, ...lines: string[]): void;
  public appendLines(
    channel: DiagnosticChannel,
    linesOrFirst: readonly string[] | string = [],
    ...remaining: string[]
  ): void {
    const lines = Array.isArray(linesOrFirst)
      ? linesOrFirst
      : [linesOrFirst, ...remaining];
    if (lines.length === 0) {
      return;
    }
    this.append(channel, `${lines.join("\n")}\n`);
  }

  /** Keep only the first `count` completed/logical lines. */
  public truncateLines(channel: DiagnosticChannel, count: number): void {
    const safeCount = normalizeCount(count);
    const buffer = this.getBuffer(channel);
    if (safeCount === 0) {
      this.setBuffer(channel, "");
      this.setEmittedBuffer(channel, "");
      if (channel === "out") {
        this.pendingDiagnosticLine = "";
      }
      return;
    }

    const hadFinalNewline = endsInLineTerminator(buffer);
    const lines = splitBufferLines(buffer).slice(0, safeCount);
    let truncated = lines.join("\n");
    if (hadFinalNewline && lines.length > 0) {
      truncated += "\n";
    }
    this.setBuffer(channel, truncated);
    this.setEmittedBuffer(channel, truncated);
    if (channel === "out") {
      this.pendingDiagnosticLine = "";
    }
  }

  /** Keep the first `byteCount` UTF-8 bytes (legacy non-`-lines` mode). */
  public truncate(channel: DiagnosticChannel, byteCount: number): void {
    const original = this.getBuffer(channel);
    const bytes = Buffer.from(original, "utf8");
    const truncated = bytes.subarray(0, Math.min(normalizeCount(byteCount), bytes.length));
    const value = truncated.toString("utf8");
    this.setBuffer(channel, value);
    this.setEmittedBuffer(channel, value);
    if (channel === "out") {
      this.pendingDiagnosticLine = "";
    }
  }

  /** Parse the effective output and update the set of published URIs. */
  public flush(): DiagnosticFlushResult {
    const outputLines = splitBufferLines(this.outBuffer);
    const outputContinues = this.outBuffer.startsWith(this.emittedOutBuffer);
    const newOutput = appendedSuffix(this.emittedOutBuffer, this.outBuffer);
    const incrementalOutput = `${outputContinues ? this.pendingDiagnosticLine : ""}${newOutput}`;
    const newOutputClassification = classifyNewOutput(
      incrementalOutput,
      this.options,
    );
    const unparsedLines: string[] = [];
    const located: LocatedDiagnostic[] = [];
    const grouped = new Map<string, AdapterDiagnostic[]>();

    for (const line of outputLines) {
      if (line.trim().length === 0) {
        continue;
      }
      if (isBoxWarningLine(line) && !this.options.showBoxWarnings) {
        continue;
      }

      const parsed = parseDiagnosticLine(line, this.options);
      if (parsed === undefined) {
        unparsedLines.push(line);
        continue;
      }
      located.push(parsed);
      const diagnostics = grouped.get(parsed.uri);
      if (diagnostics === undefined) {
        grouped.set(parsed.uri, [parsed.diagnostic]);
      } else {
        diagnostics.push(parsed.diagnostic);
      }
    }

    const currentUris = new Set(grouped.keys());
    const urisToClear = [...this.publishedUris].filter(
      (uri) => !currentUris.has(uri),
    );
    this.publishedUris = currentUris;

    const readonlyGrouped: ReadonlyMap<string, readonly AdapterDiagnostic[]> =
      grouped;
    const newLogLines = splitBufferLines(
      appendedSuffix(this.emittedLogBuffer, this.logBuffer),
    );
    this.pendingDiagnosticLine = newOutputClassification.pendingLine;
    const logLines = [
      ...newLogLines.filter((line) => line.length > 0),
      ...newOutputClassification.unparsedLines,
    ];
    this.emittedOutBuffer = this.outBuffer;
    this.emittedLogBuffer = this.logBuffer;
    return {
      byUri: readonlyGrouped,
      diagnosticsByUri: readonlyGrouped,
      diagnostics: located,
      urisToClear,
      logLines,
      unparsedLines,
      outLines: outputLines,
    };
  }

  /** Empty both buffers and return the publications needed to clear Zed. */
  public clear(): DiagnosticFlushResult {
    this.outBuffer = "";
    this.logBuffer = "";
    this.emittedOutBuffer = "";
    this.emittedLogBuffer = "";
    this.pendingDiagnosticLine = "";
    return this.flush();
  }

  /** Apply a decoded protocol message. Only `flush`/`clear` return a batch. */
  public handleMessage(
    message: readonly unknown[],
  ): DiagnosticFlushResult | undefined {
    const name = message[0];
    if (name === "append-lines") {
      const channel = parseChannel(message[1]);
      if (channel !== undefined) {
        this.appendLines(
          channel,
          message.slice(2).filter((item): item is string => typeof item === "string"),
        );
      }
      return undefined;
    }
    if (name === "truncate-lines") {
      const channel = parseChannel(message[1]);
      const count = message[2];
      if (channel !== undefined && typeof count === "number") {
        this.truncateLines(channel, count);
      }
      return undefined;
    }
    if (name === "append") {
      const channel = parseChannel(message[1]);
      // Current protocol puts text at index 2; an older integration expected
      // an offset at index 2 and text at index 3, so accept both forms.
      const text =
        typeof message[2] === "string"
          ? message[2]
          : typeof message[3] === "string"
            ? message[3]
            : undefined;
      if (channel !== undefined && text !== undefined) {
        this.append(channel, text);
      }
      return undefined;
    }
    if (name === "truncate") {
      const channel = parseChannel(message[1]);
      const count = message[2];
      if (channel !== undefined && typeof count === "number") {
        this.truncate(channel, count);
      }
      return undefined;
    }
    if (name === "flush") {
      return this.flush();
    }
    return undefined;
  }

  private getBuffer(channel: DiagnosticChannel): string {
    return channel === "out" ? this.outBuffer : this.logBuffer;
  }

  private setBuffer(channel: DiagnosticChannel, value: string): void {
    if (channel === "out") {
      this.outBuffer = value;
    } else {
      this.logBuffer = value;
    }
  }

  private setEmittedBuffer(channel: DiagnosticChannel, value: string): void {
    if (channel === "out") {
      this.emittedOutBuffer = value;
    } else {
      this.emittedLogBuffer = value;
    }
  }
}

/** Parse `error: path:line: message` and `warning: path:line: message`. */
export function parseDiagnosticLine(
  line: string,
  options: ParseDiagnosticOptions | string = {},
): LocatedDiagnostic | undefined {
  const normalizedOptions =
    typeof options === "string" ? { rootPath: options } : options;
  const columnMatch =
    /^\s*(error|warning)\s*:\s*(.+):(\d+):(\d+)\s*:\s*(.*?)\s*$/iu.exec(
      line,
    );
  const lineMatch =
    columnMatch ??
    /^\s*(error|warning)\s*:\s*(.+):(\d+)\s*:\s*(.*?)\s*$/iu.exec(line);
  if (lineMatch === null) {
    return undefined;
  }

  const severityText = lineMatch[1]?.toLowerCase();
  const rawPath = lineMatch[2];
  const rawLine = lineMatch[3];
  const hasColumn = columnMatch !== null;
  const rawColumn = hasColumn ? lineMatch[4] : undefined;
  const message = (hasColumn ? lineMatch[5] : lineMatch[4]) ?? "";
  if (
    rawPath === undefined ||
    rawLine === undefined ||
    (severityText !== "error" && severityText !== "warning")
  ) {
    return undefined;
  }
  if (
    severityText === "warning" &&
    isBoxWarningMessage(message) &&
    !normalizedOptions.showBoxWarnings
  ) {
    return undefined;
  }

  const sourceLine = Number.parseInt(rawLine, 10);
  if (!Number.isSafeInteger(sourceLine)) {
    return undefined;
  }
  const lspLine = Math.max(0, sourceLine - 1);
  const sourceColumn =
    rawColumn === undefined ? undefined : Number.parseInt(rawColumn, 10);
  const character =
    sourceColumn === undefined || !Number.isSafeInteger(sourceColumn)
      ? 0
      : Math.max(0, sourceColumn - 1);
  const endCharacter = character + 1;

  let uri: string;
  try {
    uri = diagnosticPathToUri(rawPath, normalizedOptions);
  } catch {
    return undefined;
  }

  return {
    uri,
    diagnostic: {
      range: {
        start: { line: lspLine, character },
        end: { line: lspLine, character: endCharacter },
      },
      severity:
        severityText === "error"
          ? AdapterDiagnosticSeverity.Error
          : AdapterDiagnosticSeverity.Warning,
      message,
      source: "texpresso",
    },
  };
}

export function diagnosticPathToUri(
  diagnosticPath: string,
  options: Pick<DiagnosticStateOptions, "baseDirectory" | "rootPath"> | string = {},
): string {
  const normalizedOptions =
    typeof options === "string" ? { rootPath: options } : options;
  const cleaned = stripMatchingQuotes(diagnosticPath.trim());
  if (/^file:\/\//iu.test(cleaned)) {
    return URI.file(fileURLToPath(cleaned)).toString();
  }

  const baseDirectory =
    normalizedOptions.baseDirectory ??
    (normalizedOptions.rootPath === undefined
      ? process.cwd()
      : path.dirname(normalizedOptions.rootPath));
  const absolutePath = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : path.resolve(baseDirectory, cleaned);
  return URI.file(absolutePath).toString();
}

export function isBoxWarningMessage(message: string): boolean {
  return /^\s*(?:overfull|underfull)\b/iu.test(message);
}

function isBoxWarningLine(line: string): boolean {
  return (
    /^\s*(?:overfull|underfull)\b/iu.test(line) ||
    /^\s*warning\s*:.*:\d+(?::\d+)?\s*:\s*(?:overfull|underfull)\b/iu.test(
      line,
    )
  );
}

function splitBufferLines(buffer: string): string[] {
  if (buffer.length === 0) {
    return [];
  }
  const lines = buffer.split(/\r\n|\r|\n/u);
  if (endsInLineTerminator(buffer)) {
    lines.pop();
  }
  return lines;
}

interface NewOutputClassification {
  readonly unparsedLines: string[];
  readonly pendingLine: string;
}

/**
 * Classify only newly completed output lines. A diagnostic-shaped tail is held
 * until its newline/remainder arrives so a later flush never logs just the
 * suffix of one diagnostic message.
 */
function classifyNewOutput(
  output: string,
  options: DiagnosticStateOptions,
): NewOutputClassification {
  if (output.length === 0) {
    return { unparsedLines: [], pendingLine: "" };
  }

  const terminated = endsInLineTerminator(output);
  const parts = output.split(/\r\n|\r|\n/u);
  const tail = terminated ? "" : parts.pop() ?? "";
  const unparsedLines: string[] = [];

  for (const line of parts) {
    if (line.trim().length === 0) {
      continue;
    }
    if (isBoxWarningLine(line) && !options.showBoxWarnings) {
      continue;
    }
    if (parseDiagnosticLine(line, options) === undefined) {
      unparsedLines.push(line);
    }
  }

  if (tail.trim().length === 0) {
    return { unparsedLines, pendingLine: "" };
  }
  if (isIncompleteDiagnosticLine(tail, options)) {
    return { unparsedLines, pendingLine: tail };
  }
  if (
    !isBoxWarningLine(tail) ||
    options.showBoxWarnings ||
    parseDiagnosticLine(tail, options) !== undefined
  ) {
    if (parseDiagnosticLine(tail, options) === undefined) {
      unparsedLines.push(tail);
    }
  }
  return { unparsedLines, pendingLine: "" };
}

function isIncompleteDiagnosticLine(
  line: string,
  options: DiagnosticStateOptions,
): boolean {
  if (!/^\s*(?:error|warning)\s*:/iu.test(line)) {
    return false;
  }
  const parsed = parseDiagnosticLine(line, options);
  return parsed === undefined || parsed.diagnostic.message.trim().length === 0;
}

function appendedSuffix(previous: string, current: string): string {
  if (current.startsWith(previous)) {
    return current.slice(previous.length);
  }
  // A truncate operation updates the emitted snapshot before the next append.
  // If an external caller replaced the buffer anyway, expose the replacement
  // rather than silently losing diagnostics/log output.
  return current;
}

function endsInLineTerminator(value: string): boolean {
  return /[\r\n]$/u.test(value);
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function parseChannel(value: unknown): DiagnosticChannel | undefined {
  return value === "out" || value === "log" ? value : undefined;
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  if (
    value.length >= 2 &&
    (first === '"' || first === "'") &&
    value.at(-1) === first
  ) {
    return value.slice(1, -1);
  }
  return value;
}
