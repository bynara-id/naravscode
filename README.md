# pi-vscode

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/pi0.pi-vscode?label=VS%20Code%20Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=pi0.pi-vscode) [![Open VSX](https://img.shields.io/open-vsx/v/pi0/pi-vscode?label=Open%20VSX&color=purple)](https://open-vsx.org/extension/pi0/pi-vscode)

Minimal VS Code extension for [pi coding agent](https://pi.dev/).

## Features

- **Terminal-based** — Opens pi as an integrated terminal with full TUI/PTY support (opens beside the editor)
- **VS Code bridge** — Bundles a pi extension and local bridge so pi can query live editor state
- **Editor awareness** — pi can inspect the active editor, current/latest selection, open editors, workspace folders, and VS Code diagnostics (LSP / lint / type errors)
- **Status bar button** — PI button in the status bar for quick access
- **Open with file context** — Send current file path and line range (or cursor position) to pi, available from the editor title bar
- **Send selection** — Send selected text directly to the pi terminal
- **`@pi` chat participant** — Use `@pi` in VS Code Chat for streamed RPC-backed replies while keeping the terminal workflow for normal Pi sessions
- **Package manager** — Browse, search, install, and uninstall pi packages from the sidebar with live output streaming and cancel support; automatically detects package capabilities (extensions, skills, prompts, themes)
- **Auto-detection** — Finds the pi binary automatically from common paths (`~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`)

<img width="945" height="725" alt="image" src="https://github.com/user-attachments/assets/91dbaca4-6d27-490a-8395-94a9c4d07625" />

## Requirements

- `pi` CLI installed (`npm i -g @mariozechner/pi-coding-agent` or `bun i -g @mariozechner/pi-coding-agent`)
- An API key configured for at least one provider

## Install

Available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pi0.pi-vscode) and [Open VSX](https://open-vsx.org/extension/pi0/pi-vscode):

```bash
# VS Code / Cursor
ext install pi0.pi-vscode

# Open VSX (VSCodium, etc.)
ovsx get pi0.pi-vscode
```

## Commands

| Command              | Keybinding       | Description                       |
| -------------------- | ---------------- | --------------------------------- |
| `Pi: Open`           | `Ctrl+Alt+3`     | Open or focus the pi terminal     |
| `Pi: Open with File` | Editor title bar | Open pi with current file context |
| `Pi: Send Selection` | —                | Send selected text to pi terminal |

## Sidebar

The **Pi** activity bar icon opens a sidebar with:

- **Packages view** — Search the npm registry for `pi-package` packages, see capability labels (extensions, skills, prompts, themes), install/uninstall with live streamed output, and cancel in-progress operations

## Bridge tools exposed to pi

Each pi terminal launched by the extension now loads a bundled pi extension that can call back into VS Code.

Available bridge tools:

- `vscode_get_editor_state`
- `vscode_get_selection`
- `vscode_get_latest_selection`
- `vscode_get_diagnostics`
- `vscode_get_open_editors`
- `vscode_get_workspace_folders`
- `vscode_open_file`
- `vscode_check_document_dirty`
- `vscode_save_document`
- `vscode_get_document_symbols`
- `vscode_get_references`
- `vscode_get_code_actions`
- `vscode_execute_code_action`
- `vscode_apply_workspace_edit`
- `vscode_get_notifications`
- `vscode_clear_notifications`

These tools are backed by live VS Code APIs, so pi can inspect current selections, LSP diagnostics, symbols, references, quick-fix availability, dirty state, recent editor events, and can now apply VS Code-managed edits or execute specific quick fixes on demand.

## Configuration

| Setting          | Default | Description                                             |
| ---------------- | ------- | ------------------------------------------------------- |
| `pi-vscode.path` | `""`    | Absolute path to the pi binary (auto-detected if empty) |
