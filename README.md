# TeXpresso Live for Zed

[![CI](https://github.com/Maymall/texpresso-zed/actions/workflows/ci.yml/badge.svg)](https://github.com/Maymall/texpresso-zed/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Fast, continuous [TeXpresso](https://github.com/let-def/texpresso) preview for
the LaTeX files you edit in [Zed](https://zed.dev/). TeXpresso Live keeps your
unsaved buffers in TeXpresso's virtual file system, updates the native preview
window as you type, and turns TeX errors and warnings into Zed diagnostics.

It is an **additional** language server for Zed's existing `LaTeX` language:
it does not provide a grammar and does not replace texlab. Completion, hover,
formatting, and build integrations therefore remain yours to configure as
usual.

> [!NOTE]
> The extension is prepared for the Zed Registry and its submission is pending
> review. Until it is accepted, install it as a development extension as shown
> below. The adapter is already distributed exactly as a Registry installation
> uses it: Zed downloads one pinned GitHub Release asset on first launch and
> caches it in the extension work directory.

## What you get

- Live native TeXpresso viewer in a separate window.
- Unsaved root and included files synchronized through TeXpresso's VFS.
- UTF-16-correct incremental edits, including emoji, CJK, CRLF, and multiline
  changes.
- TeX errors and warnings mapped to the correct Zed buffers.
- Deterministic root-file discovery, magic comments, and multi-root isolation.
- Code actions for forward SyncTeX, page navigation, rescan, restart, and stop.
- No shell command construction: executable paths and workspace paths may
  contain spaces.

## Requirements

| Requirement | Why it is needed |
| --- | --- |
| Linux x86_64 | The currently verified platform. |
| [TeXpresso](https://github.com/let-def/texpresso) | Owns the native viewer and TeX process. |
| TeX Live (`kpsewhich`) or Tectonic | The TeX distribution TeXpresso compiles with. |
| Network access on first launch | Lets Zed download the small, version-pinned LSP adapter. |

Zed supplies the Node runtime for the downloaded adapter. Node.js and npm are
only needed to build or test this repository; ordinary users do not install
them for the extension.

Install TeXpresso according to its upstream
[installation guide](https://github.com/let-def/texpresso/blob/main/INSTALL.md),
then make sure Zed can find it:

```sh
command -v texpresso
command -v kpsewhich # when using TeX Live
```

If a desktop launcher has a different `PATH`, use an absolute
`texpressoCommand` path in the settings below.

## Install now (development extension)

1. Clone this repository.
2. In Zed, open the Extensions view and choose **Install Dev Extension**.
3. Select this repository directory (the directory containing
   `extension.toml`).
4. Open a LaTeX root document and choose **TeXpresso: restart** from the
   code-action menu if it does not start automatically.

Zed compiles the Rust component for a dev extension. For local development,
install Rust through `rustup` and its current Zed target once:

```sh
rustup target add wasm32-wasip2
```

The normal release flow does **not** bundle `server/dist/server.mjs` into the
extension. It is built in CI, published as a tagged GitHub Release asset, and
downloaded with Zed's public extension API. This is required for Registry
extensions with a language server.

Dev Extensions use that same public API and isolated work directory; they do
**not** execute an uncommitted `server/dist/server.mjs` from the checkout.
Therefore, rebuilding or reinstalling only the dev extension cannot test an
unpublished adapter change. To test the full Zed path, first publish a new
`adapter-vX.Y.Z` asset, update the versioned constants in `src/lib.rs`, rebuild
the dev extension, and reopen the LaTeX worktree. The new versioned adapter
filename deliberately bypasses any older file in Zed's work cache.

## Settings

The adapter reads `lsp.texpresso-live.settings`. This example keeps texlab and
TeXpresso Live active together:

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

`"..."` expands to other registered language servers. When you override a
language-server list without it, omitted servers are disabled. The optional
`"!texpresso-lsp"` prevents the older Marketplace `texpresso` extension from
launching a second preview if it is also installed.

| Setting | Default | Meaning |
| --- | --- | --- |
| `texpressoCommand` | `"texpresso"` | Executable name or absolute path. |
| `rootFile` | unset | Root `.tex` path; relative to the workspace root. |
| `autoStart` | `true` | Start after opening a LaTeX document. |
| `includePaths` | `[]` | Paths passed as individual `-I` arguments. |
| `distribution` | `"default"` | `"default"`, `"texlive"`, or `"tectonic"`. |
| `showBoxWarnings` | `false` | Include `Overfull` and `Underfull` warnings. |
| `forwardSync` | `"manual"` | `"manual"` or compatibility alias `"onCodeAction"`. |
| `logLevel` | `"info"` | `error`, `warn`, `info`, `debug`, or `trace`. |
| `extraArgs` | `[]` | Extra TeXpresso arguments; `additionalArgs` is an alias. |

## Root files, child files, and diagnostics

Root choice is deterministic and never guesses between multiple candidates:

1. `rootFile` in settings.
2. `% !TEX root = relative/or/absolute.tex` in the current file.
3. `% !TeXpresso root = relative/or/absolute.tex` in the current file.
4. The current file when it contains `\\begin{document}`.
5. Exactly one plausible workspace main document within a bounded scan.

Magic-comment paths are resolved from the declaring file; configured paths are
resolved from the workspace root. If detection is ambiguous, the current
document receives a diagnostic explaining how to choose a root.

Open and changed documents use TeXpresso's `open` and `change-range` protocol
commands. Files announced by `input-file` are retained per root session, so an
included file's unsaved text is sent immediately and a closed child does not
disappear from the virtual file system prematurely. `reset-sync` rebuilds the
complete VFS after a restart.

Diagnostics are published after TeXpresso's `flush` boundary. The adapter
maintains independent rollback-aware `out` and `log` buffers, parses stderr
across chunk boundaries, clears stale diagnostics on edits/restarts, and
filters box warnings unless requested. Errors from different child files are
published to their respective document URIs.

## Preview and SyncTeX controls

The viewer is TeXpresso's native, independent preview window. Current public
Zed extension APIs do not expose an editor-tab webview or a cursor-movement
callback, so the extension deliberately does not pretend to offer an embedded
preview or automatic cursor-following sync.

Use Zed's code-action/lightbulb menu for:

- **Sync TeXpresso preview here** — sends `synctex-forward` for the selected line.
- **TeXpresso: next page** / **previous page**.
- **TeXpresso: rescan**, **restart**, and **stop**.

TeXpresso backward SyncTeX is capability-gated. Zed's generic language-server
client currently does not support the necessary `window/showDocument` request,
so the adapter logs that limitation rather than reporting a false success.

## Troubleshooting

- Open Zed's log with `zed::OpenLog`, or launch `zed --foreground`, for adapter
  download, startup, root-selection, and TeXpresso stderr messages.
- If the adapter download fails, check network access to this repository's
  GitHub Releases and restart the language server. A failed download is shown
  as a Zed language-server installation error; it does not silently fall back
  to an embedded copy.
- For TeX Live, confirm `kpsewhich` is visible to the same environment that
  launches Zed. For Tectonic, select `"distribution": "tectonic"` only after
  that installation works independently.
- A non-zero TeXpresso exit clears its diagnostics. Use **restart** to create a
  clean session and rebuild the VFS.
- The automated adapter suite runs on Linux, macOS, and Windows. Native
  TeXpresso viewer behavior still needs a viewer-capable desktop smoke test on
  the target platform before it is claimed as verified; macOS arm64 currently
  has build and engine-initialization coverage, not a published viewer smoke
  result.

## Development

```sh
npm --prefix server ci
npm --prefix server run lint
npm --prefix server run typecheck
npm --prefix server test
npm --prefix server run build
npm --prefix server run test:release-adapter
cargo fmt --check
cargo check
cargo test
cargo build --release --target wasm32-wasip2
```

The Node suite covers chunked NDJSON, UTF-16 and multiline `change-range`,
rollback/flush diagnostics, root magic comments, input-file rollback,
`reset-sync`, crash cleanup, fake-TeXpresso end-to-end LSP sessions, and a
release-adapter smoke that stages a built asset into an empty work directory
with no `texpresso` on `PATH`. The
Rust suite covers the settings bridge and release-asset identity. A real
TeXpresso smoke test is part of this project's release checklist but needs a
local TeX installation and viewer-capable desktop.

## Releasing and Registry submission

1. Build and test the source above.
2. Create and push an `adapter-vX.Y.Z` tag after updating the pinned constants
   in `src/lib.rs` and `extension.toml`'s extension version.
3. The **Release adapter** workflow bundles `server/` and uploads
   `texpresso-live-server.mjs` to that GitHub Release.
4. Run `npm --prefix server run test:release-adapter`. It starts the staged
   release adapter from an empty work directory with a configured absolute
   TeXpresso wrapper and an empty `PATH`; the wrapper must be the process that
   starts. For a published-asset check, set `TEXPRESSO_RELEASE_ADAPTER` to the
   downloaded Release asset before running the same command.
5. Test a clean Zed installation: it must download the new versioned asset
   before starting the adapter.
6. Update the Zed Registry submodule and `extensions.toml` in a pull request.

The Registry has a pre-existing extension with ID `texpresso`; this project
uses the unique `texpresso-live` ID. Its separate adapter is intentional:
TeXpresso Live implements persistent multi-root VFS synchronization,
incremental UTF-16 updates, diagnostic lifecycle handling, and verified
process cleanup. Registry acceptance remains a review decision by Zed.

## License

Apache-2.0. See [LICENSE](LICENSE).
