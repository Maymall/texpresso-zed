# TeXpresso for Zed: design record

This document records the API facts used by the implementation. It was last
checked on 2026-07-20 rather than inferred from an older Zed API.

## Sources checked

- TeXpresso at `let-def/texpresso`, including `EDITOR-PROTOCOL.md` and the
  current implementation (`14094bfbfe712651f9dd77d3e2f8f5125660111d`).
- `let-def/texpresso.vim` (`5630dca6090787c446e72886812a1b6a5716c2fa`),
  especially its process buffering, VFS reset, output rollback, and SyncTeX
  handling.
- `DominikPeters/texpresso-vscode`
  (`a8418da8d7f307abed8bb4552ec5278b260f25a9`), especially its multi-file
  registry and `change-range` implementation. Its assumption that one stdout
  event is one JSON value is deliberately not copied.
- Zed main (`f14fea9bf3c93797d5161f7440ed418655bc6c57`), the extension
  documentation, `crates/extension_api`, and the generic LSP client in
  `crates/project/src/lsp_store.rs` and `crates/lsp/src/lsp.rs`.
- The current LaTeX extension at `rzukic/zed-latex`
  (`b551cd765e2f5b7c704de105c149e78d9b03b0b9`) and the Vue language-server
  extension (`bbd770740d10fc38c72ccbd59f8898608cb70baf`) as a current
  Node-backed extension example.
- The Zed extension registry (`6411d7abe7a5cd0e3340f0bca7d3a5e5a9cf66ba`)
  and the registered `lnay/zed-texpresso` extension
  (`e4f05295e6d740a9b938d517008d65b5a4aa0a64`).
- The published `zed_extension_api` crate. Version `0.7.0` is the latest
  published version; the Zed 1.11.3 host accepts API versions through 0.7.0,
  while Zed main declares an unpublished `0.8.0` for development/nightly.
- Zed main's extension builder currently compiles Rust extensions with the
  `wasm32-wasip2` target, and the API README gives the same target-install
  command. `wasm32-wasip1` is not the target used by current Zed.

## Confirmed Zed capabilities

- A manifest can register another language server for the existing `LaTeX`
  language. It does not need to register a language or grammar.
- The extension WASM can use `zed::node_binary_path()` and can launch a script
  by an absolute path in its writable extension work directory. Zed does not
  expose the source checkout as that directory; the Vue extension works around
  this by installing its npm package there. This project embeds the development
  bundle and materializes it in that directory before launch.
- `LspSettings::for_worktree` exposes the standard `lsp.<name>.settings` and
  `initialization_options` values to the Rust launcher.
- Zed supports multiple servers for one language. A user override replaces the
  default list; `"..."` expands to all other registered servers. The coexistence
  example must therefore retain `"..."`.
- The generic LSP client supports incremental text synchronization,
  diagnostics, code actions, and `workspace/executeCommand`. Code actions are
  the public mechanism used for manual forward SyncTeX and viewer controls.
- Zed handles static `workspace/didRenameFiles` filters and dynamic
  `workspace/didChangeWatchedFiles` registrations. It does not currently emit
  `workspace/didDeleteFiles`; the adapter therefore uses a delete watcher as
  the root-deletion path while retaining the standard handler for other LSP
  clients.
- The generic client neither advertises `window.showDocument` nor installs a
  handler for `window/showDocument`. A separate Copilot client does, but that is
  not applicable to extension language servers. Backward SyncTeX is retained
  as a capability-gated module and logged when unavailable; it is not claimed
  as working in current Zed.
- The public extension API does not expose cursor movement or ordinary command
  palette contributions. Automatic forward SyncTeX is therefore not possible.
- Published API `0.7.0` exposes the workspace-configuration hook used by the
  launcher (`LspSettings::for_worktree`). The launcher mirrors the normal
  `lsp.texpresso-live.settings` object into initialization options so the
  adapter has it before an already-open buffer is synchronized during
  worktree trust. `workspace/didChangeConfiguration` remains the source of
  live updates; explicit initialization options are retained as a fallback.
- The marketplace already owns the `texpresso` extension ID. This project uses
  the unique `texpresso-live` ID (and language-server ID) so both can be
  installed without replacing one another. A settings list containing `...`
  should explicitly disable the old `texpresso-lsp` when both are installed.

## Architecture

The Rust component is intentionally only a launcher. Long-running TeXpresso
processes live in a normal Node process, not in WASM. The Node process is a
standard stdio LSP server and can own multiple TeXpresso sessions, one per
canonical root document. The fake-TeXpresso stdio E2E suite verifies that
two roots have isolated child processes, document changes, controls, and
shutdown cleanup. For a development extension, the TypeScript build
produces one bundled `server/dist/server.mjs`; `include_bytes!` embeds it in
the WASM and the launcher writes it into Zed's writable extension work
directory before invoking Zed's Node runtime. This is a practical dev path,
but current registry policy requires a future npm/release download path rather
than shipping a language-server bundle in the extension.

Each session starts an argument-array command equivalent to:

```text
texpresso -json -lines [-I path ...] [-texlive|-tectonic] [extra args ...] root.tex
```

There is no shell interpolation. TeXpresso stdout is parsed as newline-delimited
JSON with an explicit carry buffer. Stdin writes use a queue so a burst of LSP
changes cannot ignore stream backpressure.

The adapter keeps the complete text of every open or registered source. LSP
ranges are sent directly as `change-range` commands because both protocols use
zero-based UTF-16 code-unit positions. The cached text is updated with the same
semantics so a `reset-sync` or process restart can rebuild the VFS with `open`.

Root selection is deterministic: configured root, magic comment, current file
containing `\\begin{document}`, or one unique workspace main document within a
bounded scan (six levels and 2,000 files, with common build/VCS directories
skipped). Failure produces an actionable diagnostic rather than starting a
random file.

`append-lines`, `truncate-lines`, and `flush` update two rollback-aware buffers.
Compatible structured lines in `out` are published on a flush, so truncation
clears stale errors without flicker. The current TeXpresso engine also emits
its canonical `Error:`/`Warning:` records on stderr; the adapter line-frames
that UTF-8 stream, parses it immediately, merges it with protocol diagnostics,
and clears the stderr set when an edit or rescan invalidates the compilation.
File-relative diagnostic paths are resolved from the root directory before
conversion to `file:` URIs.

## Lifecycle and limitations

LSP shutdown closes every session; the Node exit hook makes a best-effort
synchronous signal for any remaining child because process-exit handlers cannot
await or reliably terminate a process group. A viewer/process exit clears its diagnostics. Configuration changes
restart sessions so command-line options take effect. A closed child buffer is
retained in the VFS while TeXpresso still reports it as an input. Root
rename/delete and workspace removal stop affected sessions; a manual Stop is
remembered so the next edit does not immediately undo the user's action.

The first supported platform is Linux x86_64 with Node 20 or newer and a local
TeXpresso installation. The adapter uses the portable Node child-process
signals (`SIGTERM` followed by `SIGKILL`) and does not claim process-group
termination; TeXpresso is expected to keep its viewer and engine under the
launched process. Windows and WSL are not claimed as tested.
