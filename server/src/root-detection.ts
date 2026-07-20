import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RootMagicKind = "tex" | "texpresso";

export interface RootMagicComment {
  readonly path: string;
  readonly kind: RootMagicKind;
  readonly line: number;
}

export type RootDetectionSource =
  | "configured"
  | "tex-magic"
  | "texpresso-magic"
  | "current-document"
  | "workspace";

export interface RootDetectionOptions {
  /** Absolute or workspace-relative path of the currently edited document. */
  readonly documentPath: string;
  readonly documentText: string;
  /** User's configured rootFile, resolved relative to the selected workspace. */
  readonly configuredRoot?: string;
  readonly workspaceFolders?: readonly string[];
  /** Optional precomputed candidates; otherwise folders are scanned. */
  readonly workspaceCandidates?: readonly string[];
  /** Lazily provide cached candidates only if higher-priority rules fail. */
  readonly workspaceCandidatesProvider?: () => readonly string[];
  readonly maxDepth?: number;
  readonly maxFiles?: number;
}

export interface FoundRoot {
  readonly found: true;
  readonly rootPath: string;
  readonly source: RootDetectionSource;
}

export interface MissingRoot {
  readonly found: false;
  readonly reason: string;
}

export type RootDetectionResult = FoundRoot | MissingRoot;

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FILES = 2_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".cache",
  ".zed",
]);

/**
 * Parse `% !TEX root = ...` or `% !TeXpresso root = ...` magic comments.
 * The standard TEX spelling wins even if the TeXpresso spelling appears
 * earlier in the file, matching the documented precedence.
 */
export function parseRootMagicComment(
  text: string,
): RootMagicComment | undefined {
  const comments = parseRootMagicComments(text);
  return comments.tex ?? comments.texpresso;
}

export interface RootMagicComments {
  readonly tex?: RootMagicComment;
  readonly texpresso?: RootMagicComment;
}

export function parseRootMagicComments(text: string): RootMagicComments {
  let tex: RootMagicComment | undefined;
  let texpresso: RootMagicComment | undefined;
  const lines = text.split(/\r\n|\r|\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // Keep this anchored to a TeX comment: a directive embedded in normal
    // source text must not silently change the session's root.
    const match = /^\s*%\s*!\s*(texpresso|tex)\s+root\s*=\s*(.*?)\s*$/iu.exec(
      line,
    );
    if (match === null || match[1] === undefined || match[2] === undefined) {
      continue;
    }
    const rawKind = match[1].toLowerCase();
    const rawPath = stripMatchingQuotes(match[2].trim());
    if (rawPath.length === 0) {
      continue;
    }
    const comment: RootMagicComment = {
      path: rawPath,
      kind: rawKind === "tex" ? "tex" : "texpresso",
      line: index,
    };
    if (comment.kind === "tex") {
      tex ??= comment;
    } else {
      texpresso ??= comment;
    }
  }
  return {
    ...(tex === undefined ? {} : { tex }),
    ...(texpresso === undefined ? {} : { texpresso }),
  };
}

/** String-only convenience for integrations that only need the directive. */
export function extractRootMagicPath(text: string): string | undefined {
  return parseRootMagicComment(text)?.path;
}

/** Resolve a root directive relative to the file declaring it. */
export function resolveDeclaredRoot(
  declaredPath: string,
  declaringDocumentPath: string,
): string {
  return resolvePath(declaredPath, path.dirname(toAbsolutePath(declaringDocumentPath)));
}

/**
 * Detect a root document in the required priority order. This function is
 * synchronous in its implementation (filesystem reads are bounded), but a
 * Promise return type makes it straightforward for LSP callers to await and
 * replace with an asynchronous scanner later.
 */
export async function detectRoot(
  options: RootDetectionOptions,
): Promise<RootDetectionResult> {
  return detectRootSync(options);
}

export function detectRootSync(
  options: RootDetectionOptions,
): RootDetectionResult {
  const documentPath = toAbsolutePath(options.documentPath);
  const workspace = chooseWorkspace(documentPath, options.workspaceFolders ?? []);

  if (nonEmpty(options.configuredRoot)) {
    return {
      found: true,
      rootPath: resolveConfiguredRoot(options.configuredRoot, workspace, documentPath),
      source: "configured",
    };
  }

  const magic = parseRootMagicComments(options.documentText);
  if (magic.tex !== undefined) {
    return {
      found: true,
      rootPath: resolveDeclaredRoot(magic.tex.path, documentPath),
      source: "tex-magic",
    };
  }
  if (magic.texpresso !== undefined) {
    return {
      found: true,
      rootPath: resolveDeclaredRoot(magic.texpresso.path, documentPath),
      source: "texpresso-magic",
    };
  }

  if (hasDocumentEnvironment(options.documentText)) {
    return { found: true, rootPath: documentPath, source: "current-document" };
  }

  const candidates =
    options.workspaceCandidates !== undefined
      ? options.workspaceCandidates.map((candidate) =>
          resolvePath(candidate, workspace ?? path.dirname(documentPath)),
        )
      : options.workspaceCandidatesProvider !== undefined
        ? options.workspaceCandidatesProvider().map((candidate) =>
            resolvePath(candidate, workspace ?? path.dirname(documentPath)),
          )
        : scanWorkspaceCandidates(
            options.workspaceFolders ?? (workspace === undefined ? [] : [workspace]),
            options.maxDepth ?? DEFAULT_MAX_DEPTH,
            options.maxFiles ?? DEFAULT_MAX_FILES,
          );
  const uniqueCandidates = uniquePaths(candidates).filter((candidate) =>
    candidate.toLowerCase().endsWith(".tex"),
  );
  if (uniqueCandidates.length === 1) {
    return {
      found: true,
      rootPath: uniqueCandidates[0] as string,
      source: "workspace",
    };
  }
  if (uniqueCandidates.length > 1) {
    return {
      found: false,
      reason:
        `Found multiple possible root TeX documents (${uniqueCandidates
          .slice(0, 8)
          .join(", ")}). Set rootFile or add a % !TEX root comment.`,
    };
  }
  return {
    found: false,
    reason:
      "Could not determine a root TeX document. Set rootFile or add % !TEX root = main.tex.",
  };
}

/** Return just the selected path, or undefined when detection is ambiguous. */
export async function detectRootPath(
  options: RootDetectionOptions,
): Promise<string | undefined> {
  const result = await detectRoot(options);
  return result.found ? result.rootPath : undefined;
}

/** Scan workspace folders for a unique `.tex` file containing `document`. */
export function findUniqueWorkspaceRoot(
  workspaceFolders: readonly string[],
  options: Pick<RootDetectionOptions, "maxDepth" | "maxFiles"> = {},
): string | undefined {
  const candidates = findWorkspaceRootCandidates(workspaceFolders, options);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Scan once so an LSP server can cache candidates across high-frequency edits. */
export function findWorkspaceRootCandidates(
  workspaceFolders: readonly string[],
  options: Pick<RootDetectionOptions, "maxDepth" | "maxFiles"> = {},
): string[] {
  return uniquePaths(scanWorkspaceCandidates(
    workspaceFolders,
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  ));
}

function resolveConfiguredRoot(
  configuredRoot: string,
  workspace: string | undefined,
  documentPath: string,
): string {
  const cleaned = stripMatchingQuotes(configuredRoot.trim());
  const base = workspace ?? path.dirname(documentPath);
  return resolvePath(cleaned, base);
}

function chooseWorkspace(
  documentPath: string,
  workspaceFolders: readonly string[],
): string | undefined {
  const absoluteFolders = workspaceFolders
    .map(toAbsolutePath)
    .filter((folder) => isPathWithin(documentPath, folder));
  absoluteFolders.sort((left, right) => right.length - left.length);
  return absoluteFolders[0];
}

function scanWorkspaceCandidates(
  workspaceFolders: readonly string[],
  maxDepth: number,
  maxFiles: number,
): string[] {
  const found: string[] = [];
  const visited = new Set<string>();
  let inspected = 0;

  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || inspected >= maxFiles) {
      return;
    }
    const absoluteDirectory = toAbsolutePath(directory);
    let identity = absoluteDirectory;
    try {
      identity = fs.realpathSync.native(absoluteDirectory);
    } catch {
      // A workspace can contain a dangling symlink; skip it below if it is
      // not readable rather than making root detection fail globally.
    }
    if (visited.has(identity)) {
      return;
    }
    visited.add(identity);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (inspected >= maxFiles) {
        return;
      }
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
        visit(path.join(absoluteDirectory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".tex")) {
        continue;
      }
      inspected += 1;
      const candidate = path.join(absoluteDirectory, entry.name);
      try {
        if (hasDocumentEnvironment(fs.readFileSync(candidate, "utf8"))) {
          found.push(candidate);
        }
      } catch {
        // Ignore unreadable files; another candidate may still be unique.
      }
    }
  };

  for (const folder of workspaceFolders) {
    visit(folder, 0);
  }
  return found;
}

function hasDocumentEnvironment(text: string): boolean {
  return /\\begin\s*\{\s*document\s*\}/u.test(text);
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    if (candidate === undefined) {
      continue;
    }
    const normalized = path.normalize(toAbsolutePath(candidate));
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function resolvePath(candidate: string, baseDirectory: string): string {
  const cleaned = stripMatchingQuotes(candidate.trim());
  if (/^file:\/\//iu.test(cleaned)) {
    return path.normalize(fileURLToPath(cleaned));
  }
  return path.normalize(path.isAbsolute(cleaned) ? cleaned : path.resolve(baseDirectory, cleaned));
}

function toAbsolutePath(candidate: string): string {
  if (/^file:\/\//iu.test(candidate)) {
    return path.normalize(fileURLToPath(candidate));
  }
  return path.normalize(path.resolve(candidate));
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}
