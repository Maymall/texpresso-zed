# TeXpresso for Zed

This is an additional Zed Language Server (`texpresso-live`) for [TeXpresso](https://github.com/let-def/texpresso). It keeps unsaved LaTeX buffers in TeXpresso's virtual file system, so the TeXpresso viewer updates while you type and TeX errors and warnings appear in Zed diagnostics. It does not provide a LaTeX grammar and does not replace `texlab`. The marketplace already has a separate extension with the `texpresso` ID; this project intentionally uses the unique `texpresso-live` ID.

The first supported platform is Linux x86_64. Node.js 20 or newer, a TeXpresso executable, and the TeX distribution selected for TeXpresso (TeX Live with `kpsewhich`, or Tectonic) are required. The adapter uses only argument arrays and never invokes a shell, so spaces in workspace paths and executable paths are supported.

## Install TeXpresso

Build and install TeXpresso by following its upstream [INSTALL.md](https://github.com/let-def/texpresso/blob/main/INSTALL.md). Verify that the executable is available before opening Zed:

```sh
command -v texpresso
```

If it is not on `PATH`, set `texpressoCommand` to an absolute executable path in the Zed settings below. The current TeXpresso CLI expects a document argument and does not expose a generic `--help`/`--version` probe.

## Install the development extension

From a checkout of this repository, build the Node adapter and install the repository as a Zed dev extension:

```sh
cd /path/to/texpresso-zed
npm --prefix server ci
npm --prefix server run build
```

In Zed, open the Extensions view, choose `Install Dev Extension`, and select the repository directory (the directory containing `extension.toml`). Zed compiles the Rust component when it installs the dev extension. Rust must be installed through `rustup`, including the `wasm32-wasip2` target used by current Zed:

```sh
rustup target add wasm32-wasip2
```

After changing TypeScript files, run `npm --prefix server run build` again before reinstalling or reloading the dev extension. The build writes a bundled adapter to `server/dist/server.mjs`; the Rust component embeds that file and writes it to Zed's extension work directory at launch. Open Zed's log with the `zed::OpenLog` action; starting Zed with `zed --foreground` provides adapter-launch diagnostics.

## Settings

The adapter reads the usual `lsp.<language-server-id>.settings` object. This example keeps both TeXpresso and texlab enabled:

```json
{
  "lsp": {
    "texpresso-live": {
      "settings": {
        "texpressoCommand": "texpresso",
        "autoStart": true,
        "distribution": "default",
        "includePaths": [],
        "showBoxWarnings": false,
        "forwardSync": "manual",
        "logLevel": "info",
        "extraArgs": []
      }
    }
  },
  "languages": {
    "LaTeX": {
      "language_servers": ["texlab", "texpresso-live", "!texpresso-lsp", "..."]
    }
  }
}
```

The launcher also mirrors this settings object into the adapter's initialization
options. This avoids a first-open race while Zed is trusting a worktree; later
`workspace/didChangeConfiguration` notifications remain the source for live
settings updates.

`"..."` is significant: in current Zed it expands to other registered language servers. If the language server list is overridden without it, the omitted servers are disabled. `"!texpresso-lsp"` prevents the older marketplace TeXpresso extension from starting a second preview when it is installed. TeXpresso only publishes its own diagnostics and code actions; syntax highlighting, completion, hover, references, formatting, and build behavior remain provided by the existing LaTeX/texlab extension.

Supported settings:

- `texpressoCommand`: executable name or absolute path; defaults to `texpresso`.
- `rootFile`: optional path to the root document. Relative paths are resolved from the workspace root.
- `autoStart`: start a session when a LaTeX document opens; defaults to `true`.
- `includePaths`: paths passed as individual `-I` arguments.
- `distribution`: `default`, `texlive`, or `tectonic`.
- `showBoxWarnings`: include `Overfull` and `Underfull` box warnings; defaults to `false`.
- `forwardSync`: manual code-action mode; defaults to `manual`. The compatibility value `onCodeAction` selects the same public Zed entry point.
- `logLevel`: `error`, `warn`, `info`, `debug`, or `trace`; it filters TeXpresso process/protocol messages, while actionable adapter errors remain visible.
- `extraArgs` (alias `additionalArgs`): additional TeXpresso arguments, passed as individual arguments before the root file.

## Choosing a root document

Root selection is deterministic. The adapter checks, in order:

1. `rootFile`.
2. `% !TEX root = relative/or/absolute.tex` in the current file.
3. `% !TeXpresso root = relative/or/absolute.tex`.
4. The current file if it contains `\\begin{document}`.
5. Exactly one workspace `.tex` file containing `\\begin{document}` within the bounded scan (six directory levels and at most 2,000 files; common build/VCS directories are skipped).

If more than one plausible workspace root exists, no TeXpresso process is started. The current document receives an actionable diagnostic asking you to set `rootFile` or a magic comment. Relative magic-comment paths are resolved from the file containing the comment, while configured paths are resolved from the workspace root.

## Editing, child files, and diagnostics

The adapter sends `open` on `didOpen` and `change-range` for every incremental LSP change. Positions are UTF-16 code units, matching both LSP and the TeXpresso protocol, including CJK text, emoji, combining characters, CRLF input, and multiline replacements. `\\input`, `\\include`, and similar files reported by TeXpresso through `input-file` are tracked. An already-open child uses its unsaved buffer; a closed child is retained in the VFS while TeXpresso still references it.

TeXpresso output is line-buffered with `-lines`. The current engine emits structured `Error: path:line: message` and `Warning: ...` records on stderr; the adapter frames that stream across UTF-8/chunk boundaries and merges those records with compatible `error:`/`warning:` lines received through the rollback-aware `out` protocol. Paths become document URIs and TeX line numbers become zero-based LSP ranges. An edit or rescan clears stale stderr diagnostics, while `truncate-lines` plus `flush` updates protocol diagnostics. Other output stays in the LSP log. Box warnings are filtered by default and can be enabled with `showBoxWarnings`.

When Zed reports a root-file or workspace-folder rename, the adapter stops the old session and records the removed path; a subsequent open of the new path can create its own session. Zed currently emits root deletion through a dynamically registered watched-file notification; that path also stops the session. Removing a workspace folder stops every session rooted below it. `Stop TeXpresso` remains in effect across subsequent edits; use `Restart TeXpresso`, `Rescan TeXpresso files`, a settings change, or an adapter reload to start it again.

## SyncTeX and viewer controls

The adapter contributes manual code actions (available from the code-action/lightbulb UI) for:

- `Sync TeXpresso preview here`
- `TeXpresso: next page`
- `TeXpresso: previous page`
- `TeXpresso: rescan`
- `TeXpresso: restart`
- `TeXpresso: stop`

The first action sends `synctex-forward` with the requested document line. Next/previous page and rescan send the corresponding TeXpresso control command; restart and stop manage the adapter's child session lifecycle. This is the public, reliable way to invoke forward SyncTeX in current Zed; ordinary cursor-movement callbacks are not available to extensions.

TeXpresso can send backward `synctex` messages. The adapter attempts standard LSP `window/showDocument` only when the client advertises that capability. Current Zed's generic language-server client does not advertise or handle that request, so it logs a clear limitation instead of pretending to open a file. The viewer remains usable, and forward SyncTeX through the manual action works.

## Development and tests

```sh
npm --prefix server ci
npm --prefix server run lint
npm --prefix server run typecheck
npm --prefix server test
npm --prefix server run build
cargo fmt --check
cargo check
cargo test
cargo build --release --target wasm32-wasip2
```

The Node test suite includes chunked and multi-message protocol parsing, UTF-16 range updates, output rollback, chunked stderr diagnostic mapping, root comments, input-file index rollback, reset-sync VFS rebuilding, symlink aliases, process failure/cleanup, terminal shutdown, root rename/delete, manual stop/restart, and two end-to-end stdio LSP tests using executable fake TeXpresso processes in paths containing spaces. The second E2E test proves that two root documents receive isolated processes, changes, controls, and shutdown cleanup. It does not require TeXpresso to be installed. CI does not launch a real TeXpresso viewer; when the executable and TeX distribution are installed, manually open `examples/minimal/main.tex` in Zed to validate the engine/viewer integration.

The Rust tests cover the settings bridge used before the first document is
synchronized, including settings precedence and a path containing spaces.

## Linux troubleshooting

- Check `command -v texpresso` from the same shell that launches Zed. Flatpak or desktop-launcher environments may have a different `PATH`; use an absolute `texpressoCommand` path when needed.
- For TeX Live, verify `command -v kpsewhich`; for Tectonic, verify the configured Tectonic installation before selecting `"distribution": "tectonic"`.
- Zed officially recommends a `rustup` toolchain for dev extensions. On Arch Linux's distro Rust, install the matching `rust-wasm` and `wasm-component-ld` packages instead of using `wasm32-wasip1`; current Zed builds `wasm32-wasip2`.
- Confirm `server/dist/server.mjs` exists after the adapter build. The Rust component embeds this bundle when Zed compiles the dev extension.
- Run `zed --foreground` and inspect `zed::OpenLog` for Node startup, root-selection, and TeXpresso stderr messages.
- A non-zero TeXpresso exit clears diagnostics and is logged. Restarting the session through its code action starts a fresh process and rebuilds the VFS.
- The Node exit hook can only make a best-effort synchronous signal during process teardown; it cannot wait for a child or terminate an external process group. Normal LSP shutdown is the reliable cleanup path.
- The first release does not claim Windows/WSL support.

## Publishing

The `texpresso` marketplace ID is already used by [`lnay/zed-texpresso`](https://github.com/lnay/zed-texpresso), so this project uses `texpresso-live`. Current Zed publishing rules also require a unique ID and say that a language server must not be shipped inside the extension; it must be downloaded or discovered through the extension API. The embedded `server.mjs` launcher described above is therefore the development-install path, not a registry-ready distribution mechanism.

Before opening a pull request to [`zed-industries/extensions`](https://github.com/zed-industries/extensions), set `extension.toml`'s `repository` to the actual public repository URL, publish the adapter as a versioned npm package or release artifact, and change the launcher to install or download it with the corresponding `zed_extension_api` capability. Then test a clean dev-extension install and follow the registry's current submodule and `extensions.toml` instructions. The extension must continue to register only the additional `LaTeX` language server and leave users free to retain texlab.
