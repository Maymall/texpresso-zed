# TeXpresso Live for Zed: design record

This record captures the externally verified API and protocol choices behind
the implementation. It was last reviewed on 2026-07-20.

## Sources checked

- TeXpresso's `EDITOR-PROTOCOL.md`, current implementation, and its Vim
  client, including VFS reset, output rollback, and SyncTeX behavior.
- `DominikPeters/texpresso-vscode`, particularly its multi-file registry and
  `change-range` handling. Its assumption that one stdout event contains one
  complete JSON value is intentionally not copied.
- Zed's extension guide, registry rules, generic LSP client, current LaTeX
  extension, and published `zed_extension_api` `0.7.0` source.
- The existing `lnay/zed-texpresso` Registry extension. It owns the
  `texpresso` ID; this project uses the separate `texpresso-live` ID.

## Confirmed Zed capabilities and boundaries

- A manifest can add a language server to Zed's existing `LaTeX` language
  without shipping a grammar or replacing texlab.
- The Rust/WASM extension can find Zed's Node runtime, download an
  uncompressed release file into its writable work directory, report language
  server installation status, and launch the downloaded script.
- A Registry extension with a language server must download that server or
  discover it in the user environment. It must not embed the server bundle in
  the extension. `src/lib.rs` therefore downloads the immutable
  `adapter-v0.1.2` GitHub Release asset once and reuses the cached file.
- `LspSettings::for_worktree` exposes normal `lsp.<id>.settings` and
  initialization options. The launcher mirrors the settings into
  initialization options to avoid a worktree-trust first-open race; normal
  configuration notifications remain the live-update source.
- Zed supports multiple servers per language. A user override replaces the
  default list and `"..."` expands to other registered servers.
- The generic LSP client supports incremental synchronization, diagnostics,
  code actions, `workspace/executeCommand`, static renames, and dynamic file
  watchers. It does not expose a tab webview, arbitrary command-palette
  registration, cursor movement callbacks, or `window/showDocument` for
  normal extension language servers.

## Architecture

```text
Zed editor
  │  extension API (WASM): cache a pinned GitHub Release adapter
  ▼
Zed-managed Node runtime
  │  stdio LSP
  ▼
TeXpresso Live adapter
  │  one argument-array child process per canonical root document
  ▼
TeXpresso + native viewer + TeX distribution
```

The Rust component only installs and launches the adapter. Long-running
TeXpresso sessions belong to the normal Node process, never to the WASM
extension. The adapter can own several isolated sessions, one for each
canonical root document.

The release asset is intentionally pinned instead of asking GitHub for the
latest release: an extension version always downloads the adapter it was
tested with. `adapter-vX.Y.Z` tags are produced by
`.github/workflows/release-adapter.yml`; a version bump updates both the
manifest version and the constants that identify the release asset.

Each TeXpresso session starts an argument array equivalent to:

```text
texpresso -json -lines [-I path ...] [-texlive|-tectonic] [extra args ...] root.tex
```

There is no shell interpolation. Stdout uses newline-delimited JSON with an
explicit carry buffer, and stdin uses a queue to respect write backpressure.

## Synchronization and diagnostics

The adapter stores the complete text of every open or registered source. It
sends `change-range` directly because LSP and TeXpresso both specify zero-based
UTF-16 code-unit positions, then updates its cached text with the same
semantics. A restart or `reset-sync` can consequently rebuild the VFS with
`open` messages.

Root selection is ordered: configured root, `% !TEX root`, `% !TeXpresso root`,
the current `\\begin{document}`, then one unique main file found by a bounded
workspace scan. An ambiguous workspace produces an actionable diagnostic
rather than a random process.

`append-lines`, `truncate-lines`, and `flush` update independent rollback-aware
`out` and `log` buffers. Structured output is published after `flush`; stderr
is UTF-8 line-framed across chunks and merged into diagnostics immediately.
Edits, rescans, exits, and session changes clear stale diagnostics. Relative
paths are resolved from the root directory before conversion to document URIs.

## Lifecycle and known limitations

LSP shutdown closes every session. The Node exit hook can send only a
best-effort synchronous signal; normal LSP shutdown is the reliable cleanup
path. A root rename/delete or workspace removal stops affected sessions, and a
manual Stop remains in effect until a deliberate restart/rescan/settings
change.

Forward SyncTeX and viewer controls are available as code actions. Backward
SyncTeX is retained as capability-gated logic but cannot be completed in the
current generic Zed LSP client because it lacks `window/showDocument`.
Likewise, an embedded preview tab is not claimed: TeXpresso's native viewer is
the supported preview surface.

The verified platform is Linux x86_64, with local TeXpresso and TeX Live or
Tectonic. The adapter is portable Node code, but Windows and WSL have not been
released as supported configurations.
