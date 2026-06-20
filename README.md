# Naraya AI for VS Code

VS Code extension for the **Naraya AI** coding agent. Drives the `naraya` CLI as
its engine — works in VS Code and forks (Cursor, Windsurf, VSCodium, Antigravity).

## Features

- **Terminal-based** — opens Naraya as an integrated terminal with full TUI/PTY support.
- **`@naraya` chat participant** — use `@naraya` in the chat panel for streamed, RPC-backed replies.
- **Sign in with Naraya** — reuses your `naraya` CLI session if you're already logged in (`naraya login`); otherwise signs in via the browser. Works across IDE forks (uses the host app's URI scheme).
- **Native permission dialogs** — gated tool actions (writes, etc.) surface as real VS Code modals — Allow / Deny — over RPC.
- **VS Code bridge** — exposes live editor state to the agent: selection, open editors, diagnostics (LSP / lint / type errors), symbols, definitions, references, and code actions.
- **Editor awareness** — "Open with file context" sends the current file + line range; "Send selection" pipes the selected text to Naraya.
- **Status bar** — a Naraya button for quick access to the terminal.

## Requirements

The `naraya` CLI must be available:

```bash
npm i -g @naraya/cli
```

The extension auto-detects it on PATH, or set `naraya.path` in settings to a
custom location. The extension shares `~/.naraya/agent`, so skills, gate, and
model config are inherited from the CLI.

## Commands

- **Naraya: Open** — open the Naraya terminal (`Ctrl+Alt+3`)
- **Naraya: Open with File** — open with the current file's context
- **Naraya: Send Selection** — send the editor selection
- **Naraya: Open in New Window**
- **Naraya: Sign in with Naraya**
- **Naraya: Upgrade Naraya CLI and Packages**

## License

MIT. Based on [pi-vscode](https://github.com/pithings/pi-vscode) (MIT) — see `NOTICE`.
