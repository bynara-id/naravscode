# pi-vscode

Minimal VS Code extension for [pi coding agent](https://pi.dev/).

## Features

- **Terminal-based** — Opens pi as an integrated terminal with full TUI/PTY support (opens beside the editor)
- **Status bar button** — `$(pi-logo) Pi` button in the status bar for quick access
- **Open with file context** — Send current file path and line range (or cursor position) to pi, available from the editor title bar
- **Send selection** — Send selected text directly to the pi terminal
- **`@pi` chat participant** — Use `@pi` in VS Code Chat to forward messages to the pi terminal
- **Auto-detection** — Finds the pi binary automatically from common paths (`~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`)

## Requirements

- `pi` CLI installed (`npm i -g @mariozechner/pi-coding-agent`)
- An API key configured for at least one provider

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `Pi: Open` | `Ctrl+Alt+P` / `Cmd+Alt+P` | Open or focus the pi terminal |
| `Pi: Open with File` | Editor title bar | Open pi with current file context |
| `Pi: Send Selection` | — | Send selected text to pi terminal |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `pi-vscode.path` | `""` | Absolute path to the pi binary (auto-detected if empty) |

## Development

```bash
pnpm install
pnpm dev    # auto-rebuild on changes (watch mode)
pnpm build  # production build
# Press F5 in VS Code to launch Extension Development Host
```

## Packaging

```bash
pnpm package  # produces pi-vscode-0.0.1.vsix
code --install-extension pi-vscode-0.0.1.vsix
```
