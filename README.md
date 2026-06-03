# Claude GUI

[中文文档](README.zh-CN.md)

Claude GUI is a local graphical shell for the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI: a Tauri desktop app, a browser UI, and a mobile-friendly layout. Once running, you can browse and continue Claude Code sessions, send messages, compare panes side by side, and reach it from your phone over a private network such as Tailscale.

> Fully local — it collects no data; every session runs through the `claude` CLI on your own machine.

---

## 1. Prerequisites (read first)

The GUI is only a shell around the `claude` CLI, so **install and sign into Claude Code first**:

1. Install the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/setup) so the `claude` command works in your terminal.
2. Run `claude` once and confirm it can chat (signed into a subscription, or with an API key configured).

Without this the GUI opens but cannot send messages.

---

## 2. Install (pick one)

### Option A: Download an installer (easiest)

Grab your platform from the [Releases page](https://github.com/wsxwj123/claude-gui/releases/latest):

| Platform | File |
|---|---|
| Windows (installer) | `Claude GUI_*_x64-setup.exe` |
| Windows (MSI) | `Claude GUI_*_x64_en-US.msi` |
| macOS (Apple Silicon) | `Claude GUI_*_aarch64.dmg` |

> Packages are unsigned / un-notarized:
> - **macOS**: right-click the app → **Open** the first time to bypass Gatekeeper (Apple Silicon only; for Intel Macs build with the `x86_64-apple-darwin` target yourself).
> - **Windows**: on the SmartScreen prompt click **More info → Run anyway**.

### Option B: Run from source (latest features, recommended)

**1. Install tooling**

- [Node.js](https://nodejs.org) 20 or newer (includes npm)
- Only needed to *package the desktop app*: Rust stable + [Tauri platform deps](https://v2.tauri.app/start/prerequisites/)

**2. Clone**

```bash
git clone https://github.com/wsxwj123/claude-gui.git
cd claude-gui
```

**3. Start it (first run auto-installs deps & builds)**

**Double-click the launcher** — the first run auto-installs dependencies, builds the frontend (a few minutes), then opens your browser at `http://localhost:6677` (close the window to stop):

- **macOS**: double-click `gui.command` (if blocked, right-click → **Open** once)
- **Windows**: double-click `gui.bat`

Or do it manually from the command line:

```bash
npm install                  # root deps
npm --prefix client install  # frontend deps
npm run build                # build the frontend
npm start                    # start the server, port 6677 by default
```

Then open **http://localhost:6677**.

---

## 3. Use it from your phone

1. Run the GUI on your computer (Option B).
2. Join the machine to your private network with [Tailscale](https://tailscale.com) (or similar).
3. On your phone, open `http://<computer-tailscale-address>:6677`.
4. Use the browser's "Add to Home Screen" for a near-native, full-screen experience.

> ⚠️ Use it **only over a private network** and set your own access password. **Never** expose a Claude Code control surface directly to the public internet.

---

## 4. Build a desktop app (optional)

```bash
npm run tauri:build
```

Output lands in `src-tauri/target/release/bundle/` (`.dmg` on macOS, `.exe` / `.msi` on Windows). For interactive desktop development use `npm run tauri:dev`.

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| Port 6677 in use | `npm run stop` to free the port, or close whatever is using it |
| Build fails with `Cannot find native binding` (vite) | Delete `client/node_modules` and re-launch (reinstalls the correct local deps); if needed `npm cache clean --force` |
| Blank page / can't send | Confirm the `claude` CLI works and Node ≥ 20; delete `client/dist` and `npm run build` again |
| Code changes not showing | From source you must `npm run build` again (or re-launch `gui.command` / `gui.bat`) |
| macOS `gui.command` does nothing | Right-click → **Open** once to authorize, or `chmod +x gui.command` |

---

## License

MIT. See [LICENSE](LICENSE).
