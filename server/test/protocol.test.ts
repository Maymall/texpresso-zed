import assert from "node:assert/strict";
import test from "node:test";

import {
  NdjsonParser,
  encodeMessage,
  parseNdjson,
} from "../src/protocol.js";

test("NDJSON parser retains a message split across chunks", () => {
  const parser = new NdjsonParser();
  const encoded = Buffer.from(JSON.stringify(["append-lines", "out", "中文😀"]) + "\n");
  const first = parser.push(encoded.subarray(0, encoded.length - 2));
  assert.deepEqual(first.messages, []);
  assert.equal(first.errors.length, 0);
  const second = parser.push(encoded.subarray(encoded.length - 2));
  assert.deepEqual(second.messages, [["append-lines", "out", "中文😀"]]);
  assert.equal(parser.pending, "");
});

test("NDJSON parser accepts multiple messages and ignores empty lines", () => {
  const parser = new NdjsonParser();
  const result = parser.push(
    `${encodeMessage(["one"])}\r\n${encodeMessage(["two", 2])}\n\n`,
  );
  assert.deepEqual(result.messages, [["one"], ["two", 2]]);
  assert.equal(result.errors.length, 0);
});

test("NDJSON parser reports invalid lines and keeps the following message", () => {
  const result = parseNdjson("not-json\n[\"ok\"]\n");
  assert.deepEqual(result.messages, [["ok"]]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.error.message ?? "", /invalid JSON/u);
});

test("NDJSON parser keeps a tail until a newline arrives", () => {
  const parser = new NdjsonParser();
  assert.deepEqual(parser.push('["tail"]'), { messages: [], errors: [] });
  assert.equal(parser.pending, '["tail"]');
  assert.deepEqual(parser.push("\n").messages, [["tail"]]);
});

test("reset discards stale partial UTF-8 state", () => {
  const parser = new NdjsonParser();
  const bytes = Buffer.from("😀");
  parser.push(bytes.subarray(0, 2));
  parser.reset();
  assert.deepEqual(parser.push('["fresh"]\n').messages, [["fresh"]]);
});
