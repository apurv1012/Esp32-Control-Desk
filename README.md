# ESP32 Control Desk

A browser-based control panel for ESP32 boards over USB — connect, watch the
live serial terminal, reset / boot into bootloader mode, and flash firmware —
all from one static web page, no backend and nothing to install.

## Requirements

- **Chrome, Edge, or another Chromium-based browser.** Web Serial (and the
  folder picker used for flashing) is not available in Firefox or Safari.
- The page must be served over **`http://localhost`** or **`https://`** —
  Web Serial refuses to run from a plain `file://` URL.

## Running it

No build step is needed. From this folder, start any static file server, e.g.:

```bash
# Python (usually already installed)
python3 -m http.server 8080

# or, with Node installed
npx serve .
```

Then open **http://localhost:8080** in Chrome or Edge.

## Using it

1. **Connect** — click *Connect*, pick the board's serial port from the
   browser's prompt, and choose a baud rate (115200 for the serial monitor;
   flashing negotiates its own speed automatically).
2. **Terminal** — everything the board prints over serial appears live. Type
   into the box at the bottom and press Enter (or *Send*) to write back to it.
3. **Device Control** — *Soft Reset* restarts the running app; *Reset to
   Bootloader* drops the chip into UART download mode. If your board's
   auto-reset wiring is non-standard, expand "Manual DTR / RTS" and toggle
   the lines by hand.
4. **Flash Firmware** — the fast path: click **Select Build Folder
   (flash_args)** and choose your ESP-IDF `build/` directory. The app reads
   that folder's `flash_args` file, resolves every referenced `.bin` against
   the folder, and fills in the flash list (offsets + files) and the
   mode/frequency/size settings automatically. Review the list, then click
   **Flash**. You can also add a single `.bin` manually with *Add File
   Manually* if you don't have a `flash_args` file.
5. **Chip Info** — *Read Chip Info* connects briefly and reports the detected
   chip (ESP32, S3, C3, …).

## How it works

- **Web Serial API** gives the page direct, user-approved access to the
  board's serial port — no drivers or backend process beyond what your OS
  already needs for the board's USB-to-serial chip.
- **[esptool-js](https://espressif.github.io/esptool-js/)** (loaded from a
  CDN as an ES module) implements the actual ESP32 flashing protocol: chip
  detection, stub-loader upload, and writing the flash.
- **[xterm.js](https://xtermjs.org/)** renders the serial terminal, including
  the ANSI colors ESP-IDF's log output uses.
- Resetting and entering the bootloader is done by toggling the port's
  **DTR/RTS** signals, the same lines most ESP32 dev boards already wire to
  an auto-reset circuit (DTR → GPIO0/BOOT, RTS → EN/RESET).

## Known limitations (see the project plan for the full roadmap)

- Chromium browsers only — this is a Web Serial / File System Access
  constraint, not something the app can work around.
- One board at a time; no multi-device view yet.
- Chip info currently reports only the chip name esptool-js returns from
  `main()` — MAC address / flash size readout is a follow-up.
- The classic DTR/RTS reset sequence assumes the common CH340/CP2102
  auto-reset wiring. Boards with inverted or custom reset circuits should use
  the manual DTR/RTS toggles.
