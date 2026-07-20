import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  parseSettings,
  sameSettings,
  sessionSettings,
} from "../src/config.js";

test("parses settings nested under the texpresso-live language-server id", () => {
  const settings = parseSettings({
    "texpresso-live": {
      texpressoCommand: "/opt/texpresso/bin/texpresso",
      rootFile: "paper/main.tex",
      autoStart: false,
      includePaths: ["paper/includes", "/shared/tex"],
      distribution: "tectonic",
      showBoxWarnings: true,
      forwardSync: "onCodeAction",
      logLevel: "debug",
      additionalArgs: ["--shell-escape", "--jobname", "paper"],
    },
  });

  assert.deepEqual(settings, {
    command: "/opt/texpresso/bin/texpresso",
    rootFile: "paper/main.tex",
    autoStart: false,
    includePaths: ["paper/includes", "/shared/tex"],
    distribution: "tectonic",
    showBoxWarnings: true,
    forwardSync: "onCodeAction",
    logLevel: "debug",
    extraArgs: ["--shell-escape", "--jobname", "paper"],
  });
  assert.equal(
    parseSettings({ settings: { "texpresso-live": { autoStart: false } } }).autoStart,
    false,
  );
});

test("accepts additionalArgs as an alias for extraArgs", () => {
  assert.deepEqual(parseSettings({ additionalArgs: ["--watch", "main.tex"] }).extraArgs, [
    "--watch",
    "main.tex",
  ]);
  assert.deepEqual(parseSettings({ extraArgs: ["--extra"] }).extraArgs, ["--extra"]);
});

test("uses documented defaults when settings are absent", () => {
  const parsed = parseSettings(undefined);
  assert.deepEqual(parsed, DEFAULT_SETTINGS);
  assert.notStrictEqual(parsed.includePaths, DEFAULT_SETTINGS.includePaths);
  assert.notStrictEqual(parsed.extraArgs, DEFAULT_SETTINGS.extraArgs);
  assert.deepEqual(sessionSettings(parsed), {
    command: "texpresso",
    includePaths: [],
    distribution: "default",
    showBoxWarnings: false,
    logLevel: "info",
    extraArgs: [],
  });
});

test("rejects malformed values instead of coercing them", () => {
  const parsed = parseSettings({
    texpressoCommand: 17,
    rootFile: "   ",
    autoStart: "yes",
    includePaths: ["valid", 17],
    distribution: "miktex",
    showBoxWarnings: 1,
    forwardSync: "automatic",
    logLevel: "verbose",
    extraArgs: "--shell-escape",
  });

  assert.deepEqual(parsed, DEFAULT_SETTINGS);
  assert.equal(sameSettings(parsed, DEFAULT_SETTINGS), true);
});
