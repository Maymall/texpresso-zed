export interface Utf16Position {
  readonly line: number;
  readonly character: number;
}

export interface Utf16Range {
  readonly start: Utf16Position;
  readonly end: Utf16Position;
}

export interface Utf16ContentChange {
  readonly text: string;
  readonly range?: Utf16Range;
}

interface LineBounds {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
}

/**
 * Convert an LSP position to a JavaScript string offset.
 *
 * JavaScript string offsets already count UTF-16 code units, so astral
 * characters (including emoji) naturally occupy two character positions.
 * Line terminators are excluded from the character count, including both
 * code units of CRLF.
 */
export function offsetAtUtf16Position(
  text: string,
  position: Utf16Position,
): number {
  const lines = lineBounds(text);
  const line = clampInteger(position.line, 0, lines.length - 1);
  const bounds = lines[line];
  if (bounds === undefined) {
    return 0;
  }
  const lineLength = bounds.contentEnd - bounds.start;
  const character = clampInteger(position.character, 0, lineLength);
  return bounds.start + character;
}

export const utf16PositionToOffset = offsetAtUtf16Position;

/** Convert a JavaScript UTF-16 string offset to an LSP position. */
export function positionAtUtf16Offset(
  text: string,
  offset: number,
): Utf16Position {
  const boundedOffset = clampInteger(offset, 0, text.length);
  const lines = lineBounds(text);

  for (let line = 0; line < lines.length; line += 1) {
    const bounds = lines[line];
    if (bounds === undefined) {
      continue;
    }
    if (boundedOffset <= bounds.contentEnd) {
      return { line, character: boundedOffset - bounds.start };
    }
    if (boundedOffset < bounds.end) {
      // An offset inside CRLF is represented as the end of the line. LSP
      // positions do not address the newline bytes themselves.
      return { line, character: bounds.contentEnd - bounds.start };
    }
  }

  const lastLine = lines.at(-1);
  return lastLine === undefined
    ? { line: 0, character: 0 }
    : {
        line: lines.length - 1,
        character: lastLine.contentEnd - lastLine.start,
      };
}

export const utf16OffsetToPosition = positionAtUtf16Offset;

/** Apply one LSP/TeXpresso UTF-16 range replacement to a string. */
export function applyUtf16RangeChange(
  text: string,
  range: Utf16Range,
  replacementText: string,
): string {
  const start = offsetAtUtf16Position(text, range.start);
  const end = offsetAtUtf16Position(text, range.end);
  if (end < start) {
    throw new RangeError("UTF-16 change range ends before it starts");
  }
  return text.slice(0, start) + replacementText + text.slice(end);
}

/** Numeric convenience matching the TeXpresso `change-range` payload. */
export function applyChangeRange(
  text: string,
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  replacementText: string,
): string {
  return applyUtf16RangeChange(
    text,
    {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
    replacementText,
  );
}

/** Apply LSP content changes in the order supplied by the client. */
export function applyUtf16ContentChanges(
  text: string,
  changes: readonly Utf16ContentChange[],
): string {
  let current = text;
  for (const change of changes) {
    current =
      change.range === undefined
        ? change.text
        : applyUtf16RangeChange(current, change.range, change.text);
  }
  return current;
}

export const applyContentChanges = applyUtf16ContentChanges;

function lineBounds(text: string): LineBounds[] {
  const lines: LineBounds[] = [];
  let start = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const codeUnit = text.charCodeAt(cursor);
    if (codeUnit === 0x0a) {
      lines.push({ start, contentEnd: cursor, end: cursor + 1 });
      cursor += 1;
      start = cursor;
      continue;
    }
    if (codeUnit === 0x0d) {
      const end = text.charCodeAt(cursor + 1) === 0x0a ? cursor + 2 : cursor + 1;
      lines.push({ start, contentEnd: cursor, end });
      cursor = end;
      start = cursor;
      continue;
    }
    cursor += 1;
  }

  // There is always at least one line, including after a final terminator.
  lines.push({ start, contentEnd: text.length, end: text.length });
  return lines;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
