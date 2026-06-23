# ByNara AI for VS Code

VS Code extension for the **ByNara AI** coding agent. Drives the `naracli` CLI as
its engine — works in VS Code and forks (Cursor, Windsurf, VSCodium, Antigravity).

## Features

- **Terminal-based** — opens ByNara as an integrated terminal with full TUI/PTY support.
- **`@bynara` chat participant** — use `@bynara` in the chat panel for streamed, RPC-backed replies.
- **Sign in with ByNara** — reuses your `naracli` CLI session if you're already logged in (`naracli login`); otherwise signs in via the browser. Works across IDE forks (uses the host app's URI scheme).
- **Native permission dialogs** — gated tool actions (writes, etc.) surface as real VS Code modals — Allow / Deny — over RPC.
- **VS Code bridge** — exposes live editor state to the agent: selection, open editors, diagnostics (LSP / lint / type errors), symbols, definitions, references, and code actions.
- **Editor awareness** — "Open with file context" sends the current file + line range; "Send selection" pipes the selected text to ByNara.
- **Status bar** — a ByNara button for quick access to the terminal.

## Requirements

The `naracli` CLI must be available (npm package `bynara-cli`):

```bash
npm i -g bynara-cli
```

The extension auto-detects it on PATH, or set `bynara.path` in settings to a
custom location. The extension shares `~/.bynara/agent`, so skills, gate, and
model config are inherited from the CLI.

## Commands

- **ByNara: Open** — open the ByNara terminal (`Ctrl+Alt+3`)
- **ByNara: Open with File** — open with the current file's context
- **ByNara: Send Selection** — send the editor selection
- **ByNara: Open in New Window**
- **ByNara: Sign in with ByNara**
- **ByNara: Upgrade ByNara CLI and Packages**

## License

MIT. Based on [pi-vscode](https://github.com/pithings/pi-vscode) (MIT) — see `NOTICE`.
