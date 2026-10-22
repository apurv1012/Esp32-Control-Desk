# ESP32 Control Desk — CLAUDE.md

Project context for Claude Code (or any future session) working in this repo.

## What this is

A browser-based control panel for ESP32 boards over USB. No backend, no
build step — a static HTML/CSS/JS page that talks directly to the board
via the **Web Serial API**, and uses **esptool-js** (loaded from a CDN as
an ES module) to speak the ESP32 flashing protocol. See
`README.md` for end-user usage instructions.

A durable build plan and a feature comparison against the VS Code
ESP-IDF extension live in the attached claude.ai Project's docs
(`claude/esp32-control-desk-plan.md`,
`claude/esp32-control-desk-vscode-feature-comparison.md`) — read those
for the full feature list, roadmap, and scope decisions (what's
intentionally out of scope, like JTAG debugging and project/build
tooling, and why).

## File layout

```
index.html    — page structure, all panels (Device Control, Chip Info,
                Flash Firmware, Serial Terminal)
style.css     — all styling; CSS custom properties under
                :root[data-theme="dark"|"light"] drive the theme toggle
app.js        — all application logic (ES module, imports esptool-js and
                xterm.js from esm.sh/jsdelivr CDNs — no npm install needed)
assets/logo.png — Yantrify logo (white mark, transparent background —
                  always render it inside a dark chip, see .logo-badge)
README.md     — end-user setup/usage instructions
ESP32-Control-Desk.exe — optional Windows launcher, see "The .exe" below
```

## Hard constraints (don't "fix" these — they're inherent to the platform)

- **Chromium browsers only.** Web Serial is not implemented in Firefox or
  Safari. There's a banner in `index.html`/`app.js` that detects this and
  tells the user.
- **Must run from `http://localhost` or `https://`, never `file://`.**
  Web Serial refuses to initialize from a plain file URL.
- **Cannot be published as a Claude.ai Artifact.** Artifacts render inside
  an iframe; Web Serial only works in a top-level browsing context. This
  is why we built the standalone `.exe` launcher and discussed GitHub
  Pages instead of an Artifact when the user asked for "web access."

## Key implementation details worth knowing before touching app.js

- **`withExclusiveTransport()`** (the shared helper used by Flash, Erase,
  and Read Chip Info) is the trickiest part of the file. `esptool-js`'s
  `ESPLoader.main()` calls `transport.connect()` internally, which calls
  `port.open()` — and that throws if the port is already open. Since the
  live terminal holds the port open for monitoring, this helper **closes
  the port before constructing `Transport`/`ESPLoader`**, then reopens it
  afterward so the terminal can resume. Skipping this close is the #1 way
  to silently break flashing (it hangs at "Preparing..." with no visible
  error unless you scroll to the footer).
- **`monitorBaud`** is tracked separately from the baud `<select>`'s
  live value. The same dropdown is reused as the "flash transfer speed"
  hint passed to `ESPLoader`, so if a user bumps it up before flashing,
  reopening the monitor afterward must use the *original* connect baud
  (`monitorBaud`), not whatever the dropdown currently shows — otherwise
  the terminal goes silent/garbled after a flash even though the board is
  logging fine.
- **`flash_args` parsing** (`parseFlashArgs()`) expects the exact format
  ESP-IDF's build system writes: line 1 is
  `--flash_mode X --flash_freq Y --flash_size Z`, every line after is
  `<hex offset> <relative/path/to/file.bin>`. Files are resolved against
  whatever folder the user picked via the `webkitdirectory` file input
  (not the File System Access API — kept it to the simpler input picker
  for consistent Chrome/Edge behavior).
- **Reset/bootloader sequencing** (`softResetBtn`/`bootloaderResetBtn`)
  pulses DTR/RTS directly via `port.setSignals()` using the standard
  classic-reset timing (DTR→GPIO0/BOOT, RTS→EN/RESET). This assumes the
  common CH340/CP2102 auto-reset wiring; the manual DTR/RTS toggles exist
  as an escape hatch for boards wired differently.
- **Chip Info** reads MAC via `loader.chip.readMac(loader)` and flash
  size via `loader.detectFlashSize()` — neither is exposed as a simple
  stored property on `ESPLoader`, they have to be called explicitly after
  `main()` resolves (see `esptool-js`'s source if extending this further).

## The `.exe` launcher

`ESP32-Control-Desk.exe` is a separate, optional convenience — **not**
required to use the tool (anyone can just run a static file server and
open `index.html`). It's a small Go program (source kept outside this
folder, in the build environment that produced it) that:

- Embeds `index.html`, `style.css`, `app.js`, and `assets/logo.png` via
  `go:embed` — fully self-contained, nothing else needed at runtime.
- Serves them on `http://127.0.0.1:8743` (falls back to a random free
  port if that one's taken).
- Opens the page directly in Edge via the `microsoft-edge:` URI scheme
  (bypassing whatever the user's default browser is set to), falling
  back to the OS default-open mechanism if that fails.

**It must be rebuilt from source whenever `index.html`/`style.css`/
`app.js`/the logo change** — the files are embedded at compile time, not
read from disk at runtime, so copying a new `app.js` into this folder
alone does *not* update what the `.exe` serves. If asked to update it,
rebuild with:

```bash
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ESP32-Control-Desk.exe .
```

(run from the Go module directory containing `main.go` and a `web/`
subfolder with fresh copies of the four files above), then replace the
`.exe` in this project folder.

## Open items / known follow-ups

See the "Worth adding next" section of
`claude/esp32-control-desk-vscode-feature-comparison.md` for a prioritized
list (partition-table viewer, ELF-based binary size analysis, a
diagnostics/"doctor" panel, eFuse viewer). None of these are started yet.
