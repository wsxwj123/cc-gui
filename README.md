# Claude GUI

[中文文档](README.zh-CN.md)

Claude GUI is a local desktop and mobile-friendly web shell for Claude Code CLI.
It provides a Tauri desktop app, a browser UI for local use, and a phone layout
that works well when exposed through a private network such as Tailscale and
added to the phone home screen.

## Download

Prebuilt installers are on the [Releases page](https://github.com/wsxwj123/claude-gui/releases/latest):

| Platform | File |
|---|---|
| Windows (installer) | `Claude GUI_*_x64-setup.exe` |
| Windows (MSI) | `Claude GUI_*_x64_en-US.msi` |
| macOS (Apple Silicon) | `Claude GUI_*_aarch64.dmg` |

> **macOS is Apple Silicon (aarch64) only.** Intel Macs are not covered yet;
> build with the `x86_64-apple-darwin` target yourself.
>
> **The packages are unsigned / un-notarized.** On macOS, right-click the app
> and choose **Open** the first time to bypass Gatekeeper. On Windows, click
> **More info → Run anyway** past the SmartScreen warning.

## Features

- Browse and continue Claude Code project sessions from a GUI.
- Send messages through the local Claude Code CLI workflow.
- Manage common local GUI settings without committing machine-specific state.
- Use a mobile-first PWA-style layout for phone access over LAN or Tailscale.
- Build a native desktop shell with Tauri.
- Keep local-only private extensions out of public builds.

## Public Build Policy

The repository is intended to publish only the reusable shell. Machine-private
extensions are intentionally ignored and audited before public builds:

- `AGENTS.md`
- `.claude/`
- `client/dist/`
- `server/routes/*.local.js`
- `client/src/components/*.local.jsx`

Local-only modules can exist on your machine, but they are not tracked by Git
and are excluded from public web and Tauri builds by `npm run build` and
`npm run tauri:build`.

## Requirements

- Node.js LTS, tested with Node.js 20+
- npm
- Rust stable
- Platform dependencies required by Tauri v2

See the official Tauri prerequisites page for OS-specific setup:
<https://v2.tauri.app/start/prerequisites/>

On macOS desktop-only development, Tauri can use Xcode Command Line Tools:

```bash
xcode-select --install
```

## Installation

```bash
git clone https://github.com/wsxwj123/claude-gui.git
cd claude-gui
npm install
cd client
npm install
cd ..
```

## Development

Run the local server and Vite client together:

```bash
npm run dev
```

The backend listens on port `6677` by default. For local production mode:

```bash
npm run build
npm run start
```

## Mobile Use Through Tailscale

1. Run the local server on your Mac or workstation.
2. Expose the machine through Tailscale or another private network.
3. Open the GUI URL on your phone.
4. Add the page to the home screen.

Use a private network and your own local authentication setup. Do not expose a
Claude Code control surface directly to the public internet.

## Tauri Desktop Build

Build the public frontend and package the desktop app:

```bash
npm run tauri:build
```

This command runs the public-build guard before Tauri packaging. The Tauri
source lives in `src-tauri/`; generated build output under `src-tauri/target/`
is not committed.

For interactive desktop development:

```bash
npm run tauri:dev
```

## Public Audit

Before committing or releasing, run:

```bash
npm run audit:public
```

The audit fails if private local modules, `AGENTS.md`, `.claude/`, or generated
client build output are tracked by Git, or if local-only bot controls appear in
the public build output.

## License

MIT. See [LICENSE](LICENSE).
