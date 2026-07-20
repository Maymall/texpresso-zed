import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChangeRange,
  applyUtf16RangeChange,
  offsetAtUtf16Position,
  positionAtUtf16Offset,
} from "../src/utf16.js";

test("applies ASCII UTF-16 changes", () => {
  assert.equal(
    applyChangeRange("hello world", 0, 6, 0, 11, "zed"),
    "hello zed",
  );
});

test("CJK characters count as one UTF-16 code unit", () => {
  assert.equal(
    applyChangeRange("你好世界", 0, 2, 0, 4, "朋友"),
    "你好朋友",
  );
});

test("emoji count as two UTF-16 code units", () => {
  const text = "a😀bc";
  assert.equal(offsetAtUtf16Position(text, { line: 0, character: 3 }), 3);
  assert.equal(
    applyUtf16RangeChange(
      text,
      { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } },
      "X",
    ),
    "aXbc",
  );
});

test("combining marks keep their individual UTF-16 positions", () => {
  const decomposed = "Cafe\u0301 noir";
  assert.equal(
    applyChangeRange(decomposed, 0, 3, 0, 5, "é"),
    "Café noir",
  );
});

test("multiline CRLF changes exclude the CRLF terminator from character counts", () => {
  const text = "first😀\r\n第二行\r\nlast";
  const changed = applyUtf16RangeChange(
    text,
    { start: { line: 0, character: 5 }, end: { line: 1, character: 2 } },
    "\n中",
  );
  assert.equal(changed, "first\n中行\r\nlast");
  assert.deepEqual(positionAtUtf16Offset(text, text.indexOf("第二")), {
    line: 1,
    character: 0,
  });
});
