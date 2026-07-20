import { StringDecoder } from "node:string_decoder";

/** A JSON value emitted by TeXpresso in JSON mode. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** TeXpresso messages are JSON arrays (the first item is the message name). */
export type TeXpressoMessage = readonly unknown[];

export interface ProtocolParseError {
  /** The complete line that could not be decoded. */
  readonly line: string;
  readonly error: Error;
}

export interface ParseBatch {
  readonly messages: TeXpressoMessage[];
  readonly errors: ProtocolParseError[];
}

export interface NdjsonParserOptions {
  /** Called for each valid message, in arrival order. */
  readonly onMessage?: (message: TeXpressoMessage) => void;
  /** Called for malformed or non-array lines. */
  readonly onError?: (error: ProtocolParseError) => void;
  /** Accept JSON values other than arrays (useful for generic NDJSON streams). */
  readonly allowNonArray?: boolean;
}

/**
 * Incremental newline-delimited JSON parser.
 *
 * stdout data events do not have message boundaries.  This parser retains a
 * partial line between calls, accepts multiple lines in one chunk, ignores
 * blank lines, and reports malformed lines without stopping the stream.
 */
export class NdjsonParser {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private readonly options: NdjsonParserOptions;

  public constructor(
    options: NdjsonParserOptions | ((message: TeXpressoMessage) => void) = {},
  ) {
    this.options =
      typeof options === "function" ? { onMessage: options } : options;
  }

  /** The uncompleted (not yet newline-terminated) line, if any. */
  public get pending(): string {
    return this.buffer;
  }

  /** Feed one stdout chunk and return all complete messages found in it. */
  public push(chunk: string | Uint8Array): ParseBatch {
    // StringDecoder is important for a multi-byte UTF-8 character split over
    // two Buffer data events.  Strings are already decoded by Node callers.
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.write(Buffer.from(chunk));
    return this.drainCompleteLines();
  }

  /**
   * Finish a stream. A non-empty partial line is reported as an incomplete
   * message because TeXpresso frames every message with a newline.
   */
  public finish(): ParseBatch {
    this.buffer += this.decoder.end();
    const batch = this.drainCompleteLines();
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return batch;
    }

    const line = this.buffer;
    this.buffer = "";
    const error = new Error("incomplete NDJSON message (missing newline)");
    const parseError = { line, error } satisfies ProtocolParseError;
    this.options.onError?.(parseError);
    return {
      messages: batch.messages,
      errors: [...batch.errors, parseError],
    };
  }

  /** Drop buffered data and reset the UTF-8 decoder for a restarted process. */
  public reset(): void {
    this.buffer = "";
    this.decoder.end();
    this.decoder = new StringDecoder("utf8");
  }

  private drainCompleteLines(): ParseBatch {
    const messages: TeXpressoMessage[] = [];
    const errors: ProtocolParseError[] = [];

    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.trim().length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (cause) {
        const error = new Error(
          `invalid JSON message: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        const parseError = { line, error } satisfies ProtocolParseError;
        errors.push(parseError);
        this.options.onError?.(parseError);
        continue;
      }

      if (!this.options.allowNonArray && !Array.isArray(parsed)) {
        const error = new Error("protocol message must be a JSON array");
        const parseError = { line, error } satisfies ProtocolParseError;
        errors.push(parseError);
        this.options.onError?.(parseError);
        continue;
      }

      // allowNonArray is deliberately typed as unknown[] at the boundary as
      // TeXpresso consumers should still validate the command shape.
      const message = parsed as TeXpressoMessage;
      messages.push(message);
      this.options.onMessage?.(message);
    }

    return { messages, errors };
  }
}

/** Backwards-compatible name used by some adapter integrations. */
export class JsonLineParser extends NdjsonParser {}

/** Another descriptive alias for callers that prefer the protocol name. */
export class TexpressoProtocolParser extends NdjsonParser {}

/** Encode one editor -> TeXpresso command as a newline-delimited JSON line. */
export function encodeMessage(message: readonly unknown[]): string {
  const encoded = JSON.stringify(message);
  if (encoded === undefined) {
    throw new TypeError("cannot encode an undefined protocol message");
  }
  return `${encoded}\n`;
}

export const encodeNdjsonMessage = encodeMessage;

/** Parse a complete NDJSON string in one call. */
export function parseNdjson(text: string): ParseBatch {
  const parser = new NdjsonParser();
  return parser.push(text.endsWith("\n") ? text : `${text}\n`);
}
