import type { SessionSettings } from "./texpresso-session.js";

export type ForwardSyncMode = "manual" | "onCodeAction";
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

type NormalizedSessionSetting =
  | "command"
  | "includePaths"
  | "distribution"
  | "extraArgs"
  | "showBoxWarnings";

export interface ServerSettings
  extends Required<Pick<SessionSettings, NormalizedSessionSetting>> {
  rootFile: string | undefined;
  autoStart: boolean;
  forwardSync: ForwardSyncMode;
  logLevel: LogLevel;
}

const DEFAULT_LOG_LEVEL: LogLevel = "info";

export const DEFAULT_SETTINGS: Readonly<ServerSettings> = {
  command: "texpresso",
  rootFile: undefined,
  autoStart: true,
  includePaths: [],
  distribution: "default",
  showBoxWarnings: false,
  forwardSync: "manual",
  logLevel: DEFAULT_LOG_LEVEL,
  extraArgs: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsObject(value: unknown): Record<string, unknown> {
  let current: unknown = value;
  // Initialization options are commonly nested, while Zed's workspace
  // configuration response is the settings object itself. Allow both forms
  // without making callers know which transport supplied the value.
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) {
      return {};
    }
    const record = current;
    const nested = ["texpresso-live", "settings", "texpresso", "texpresso-zed"]
      .map((key) => record[key])
      .find(isRecord);
    if (nested === undefined) {
      return current;
    }
    current = nested;
  }
  return isRecord(current) ? current : {};
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : [];
}

function logLevel(value: unknown): LogLevel {
  return value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug" ||
    value === "trace"
    ? value
    : DEFAULT_LOG_LEVEL;
}

export function parseSettings(value: unknown): ServerSettings {
  const raw = settingsObject(value);
  const distribution =
    raw.distribution === "texlive" || raw.distribution === "tectonic"
      ? raw.distribution
      : "default";
  const forwardSync: ForwardSyncMode =
    raw.forwardSync === "onCodeAction" ? "onCodeAction" : "manual";
  const rootFile =
    typeof raw.rootFile === "string" && raw.rootFile.trim().length > 0
      ? raw.rootFile
      : undefined;

  return {
    command: nonEmptyString(raw.texpressoCommand ?? raw.command, DEFAULT_SETTINGS.command),
    rootFile,
    autoStart: typeof raw.autoStart === "boolean" ? raw.autoStart : DEFAULT_SETTINGS.autoStart,
    includePaths: stringArray(raw.includePaths),
    distribution,
    showBoxWarnings:
      typeof raw.showBoxWarnings === "boolean"
        ? raw.showBoxWarnings
        : DEFAULT_SETTINGS.showBoxWarnings,
    forwardSync,
    logLevel: logLevel(raw.logLevel),
    extraArgs: stringArray(raw.extraArgs ?? raw.additionalArgs),
  };
}

export function sameSettings(left: ServerSettings, right: ServerSettings): boolean {
  return (
    left.command === right.command &&
    left.rootFile === right.rootFile &&
    left.autoStart === right.autoStart &&
    left.distribution === right.distribution &&
    left.showBoxWarnings === right.showBoxWarnings &&
    left.forwardSync === right.forwardSync &&
    left.logLevel === right.logLevel &&
    left.includePaths.length === right.includePaths.length &&
    left.includePaths.every((value, index) => value === right.includePaths[index]) &&
    left.extraArgs.length === right.extraArgs.length &&
    left.extraArgs.every((value, index) => value === right.extraArgs[index])
  );
}

export function sessionSettings(settings: ServerSettings): SessionSettings {
  return {
    command: settings.command,
    includePaths: [...settings.includePaths],
    distribution: settings.distribution,
    showBoxWarnings: settings.showBoxWarnings,
    logLevel: settings.logLevel,
    extraArgs: [...settings.extraArgs],
  };
}
