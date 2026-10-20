// ESP32 Control Desk — main application logic
//
// Everything here runs client-side in the browser. There is no backend:
// the page talks to the board directly over USB using the Web Serial API,
// and uses esptool-js (loaded from a CDN as an ES module) to speak the
// ESP32 flashing protocol.
//
// Browser support: Chrome / Edge / other Chromium browsers only.
// Web Serial is not implemented in Firefox or Safari.

import { ESPLoader, Transport } from "https://esm.sh/esptool-js";
import { Terminal } from "https://esm.sh/xterm@5.3.0";
import { FitAddon } from "https://esm.sh/xterm-addon-fit@0.8.0";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const statusDot = $("statusDot");
const statusText = $("statusText");
const baudSelect = $("baudSelect");
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const themeBtn = $("themeBtn");
const unsupportedBanner = $("unsupportedBanner");

const softResetBtn = $("softResetBtn");
const bootloaderResetBtn = $("bootloaderResetBtn");
const dtrToggle = $("dtrToggle");
const rtsToggle = $("rtsToggle");
const bootModeText = $("bootModeText");

const chipInfoBtn = $("chipInfoBtn");
const infoChip = $("infoChip");

const pickFolderBtn = $("pickFolderBtn");
const addFileBtn = $("addFileBtn");
const folderHint = $("folderHint");
const flashTableBody = $("flashTableBody");
const flashModeSelect = $("flashModeSelect");
const flashFreqSelect = $("flashFreqSelect");
const flashSizeSelect = $("flashSizeSelect");
const eraseAllCheck = $("eraseAllCheck");
const flashBtn = $("flashBtn");
const eraseFlashBtn = $("eraseFlashBtn");
const progressWrap = $("progressWrap");
const progressFill = $("progressFill");
const progressText = $("progressText");

const timestampToggle = $("timestampToggle");
const filterInput = $("filterInput");
const clearTermBtn = $("clearTermBtn");
const exportLogBtn = $("exportLogBtn");
const terminalEl = $("terminal");
const sendForm = $("sendForm");
const sendInput = $("sendInput");
const lineEndingSelect = $("lineEndingSelect");
const sendBtn = $("sendBtn");
const footerMsg = $("footerMsg");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let port = null;            // the raw SerialPort from navigator.serial
let reader = null;          // ReadableStreamDefaultReader while in "monitor" mode
let readLoopPromise = null;
let keepReading = false;
let isFlashing = false;

// Flash queue: [{ offset: "0x1000", name: "app.bin", size: 12345, file: File }]
let flashQueue = [];

const textEncoder = new TextEncoder();
const sessionLog = []; // plain-text lines, for export

// ---------------------------------------------------------------------------
// Terminal (xterm.js) setup
// ---------------------------------------------------------------------------
const fitAddon = new FitAddon();
const term = new Terminal({
  convertEol: true,
  fontSize: 13,
  theme: { background: "#000000" },
  scrollback: 5000,
});
term.loadAddon(fitAddon);
term.open(terminalEl);
fitAddon.fit();
window.addEventListener("resize", () => fitAddon.fit());

function writeTerminal(text, { isEsptool = false } = {}) {
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    if (line === "" && i === lines.length - 1) return; // trailing split artifact
    const prefix = timestampToggle.checked ? `[${new Date().toLocaleTimeString()}] ` : "";
    const tag = isEsptool ? "[esptool] " : "";
    const full = prefix + tag + line;
    sessionLog.push(full);
    const filterVal = filterInput.value.trim();
    if (!filterVal || full.toLowerCase().includes(filterVal.toLowerCase())) {
      term.writeln(full);
    }
  });
}

// Terminal object esptool-js can log through, so its progress messages land
// in the same view as the device's own serial output.
const espLoaderTerminal = {
  clean: () => term.clear(),
  writeLine: (data) => writeTerminal(String(data), { isEsptool: true }),
  write: (data) => writeTerminal(String(data), { isEsptool: true }),
};

clearTermBtn.addEventListener("click", () => {
  term.clear();
  sessionLog.length = 0;
});

exportLogBtn.addEventListener("click", () => {
  const blob = new Blob([sessionLog.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `esp32-session-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

filterInput.addEventListener("input", () => {
  // Re-render the buffer against the new filter.
  term.clear();
  const filterVal = filterInput.value.trim().toLowerCase();
  sessionLog.forEach((line) => {
    if (!filterVal || line.toLowerCase().includes(filterVal)) term.writeln(line);
  });
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
themeBtn.addEventListener("click", () => {
  const html = document.documentElement;
  const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
});

// ---------------------------------------------------------------------------
// Browser support check
// ---------------------------------------------------------------------------
if (!("serial" in navigator)) {
  unsupportedBanner.classList.remove("hidden");
  connectBtn.disabled = true;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
function setStatus(state, label) {
  statusDot.className = `status-dot status-${state}`;
  statusText.textContent = label;
}

function setConnectedUIState(connected) {
  disconnectBtn.disabled = !connected;
  connectBtn.disabled = connected;
  softResetBtn.disabled = !connected;
  bootloaderResetBtn.disabled = !connected;
  dtrToggle.disabled = !connected;
  rtsToggle.disabled = !connected;
  chipInfoBtn.disabled = !connected;
  pickFolderBtn.disabled = !connected;
  addFileBtn.disabled = !connected;
  flashBtn.disabled = !connected || flashQueue.length === 0;
  eraseFlashBtn.disabled = !connected;
  sendInput.disabled = !connected;
  sendBtn.disabled = !connected;
}

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("connecting", "Connecting...");
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: parseInt(baudSelect.value, 10) });
    setStatus("connected", "Connected");
    setConnectedUIState(true);
    footerMsg.textContent = "Connected. Watching for serial output...";
    startReading();

    port.addEventListener("disconnect", () => {
      // Board was physically unplugged.
      handleUnexpectedDisconnect();
    });
  } catch (err) {
    if (err?.name === "NotFoundError") {
      // User closed the port picker without choosing a device — not an error.
      setStatus("disconnected", "Disconnected");
    } else {
      console.error(err);
      footerMsg.textContent = `Connection failed: ${err.message}`;
      setStatus("disconnected", "Disconnected");
    }
    setConnectedUIState(false);
  }
});

disconnectBtn.addEventListener("click", async () => {
  await stopReading();
  try {
    await port.close();
  } catch (err) {
    console.warn("Error while closing port:", err);
  }
  port = null;
  setStatus("disconnected", "Disconnected");
  setConnectedUIState(false);
  bootModeText.textContent = "Unknown";
  footerMsg.textContent = "Disconnected.";
});

function handleUnexpectedDisconnect() {
  keepReading = false;
  port = null;
  reader = null;
  setStatus("disconnected", "Disconnected");
  setConnectedUIState(false);
  footerMsg.textContent = "Board was disconnected (unplugged or lost power).";
}

// ---------------------------------------------------------------------------
// Reading the serial stream ("monitor" mode)
//
// Only one reader may be attached to port.readable at a time, and esptool-js
// needs exclusive access to the port while flashing. So the read loop is
// stopped before handing the port to esptool-js, and restarted afterwards.
// ---------------------------------------------------------------------------
function startReading() {
  if (!port || !port.readable) return;
  keepReading = true;
  readLoopPromise = readLoop();
}

async function readLoop() {
  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable).catch(() => {
    /* expected when the stream is cancelled on purpose */
  });
  reader = textDecoder.readable.getReader();

  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) writeTerminal(value);
    }
  } catch (err) {
    if (keepReading) console.warn("Read loop error:", err);
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {}
    await readableStreamClosed;
  }
}

async function stopReading() {
  if (!keepReading) return;
  keepReading = false;
  try {
    await reader?.cancel();
  } catch (_) {}
  await readLoopPromise;
  reader = null;
}

// ---------------------------------------------------------------------------
// Sending data to the device
// ---------------------------------------------------------------------------
sendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!port || !port.writable) return;
  const ending = lineEndingSelect.value
    .replace("\\n", "\n")
    .replace("\\r", "\r");
  const text = sendInput.value + ending;
  const writer = port.writable.getWriter();
  try {
    await writer.write(textEncoder.encode(text));
  } finally {
    writer.releaseLock();
  }
  sendInput.value = "";
});

// ---------------------------------------------------------------------------
// Device control: reset / bootloader
//
// Classic reset circuit (CH340 / CP2102 / similar auto-reset boards):
//   DTR -> GPIO0 (BOOT)   RTS -> EN (RESET)
// Signal polarity depends on the board's inverting transistors; this is the
// standard esptool.py "classic_reset" sequence. If a board's buttons behave
// backwards, use the manual DTR/RTS toggles instead.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setSignals(dtr, rts) {
  await port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
  dtrToggle.checked = dtr;
  rtsToggle.checked = rts;
}

softResetBtn.addEventListener("click", async () => {
  if (!port) return;
  footerMsg.textContent = "Resetting...";
  await setSignals(false, true);   // EN low: hold in reset
  await sleep(100);
  await setSignals(false, false);  // EN high, IO0 high: boot the app normally
  bootModeText.textContent = "Running (app)";
  footerMsg.textContent = "Soft reset sent.";
});

bootloaderResetBtn.addEventListener("click", async () => {
  if (!port) return;
  footerMsg.textContent = "Resetting to bootloader...";
  await setSignals(false, true);   // EN low: hold in reset
  await sleep(100);
  await setSignals(true, false);   // IO0 low, EN high: come out of reset into bootloader
  await sleep(50);
  await setSignals(false, false);  // release IO0
  bootModeText.textContent = "Bootloader (download mode)";
  footerMsg.textContent = "Board should now be in UART bootloader mode.";
});

dtrToggle.addEventListener("change", () => setSignals(dtrToggle.checked, rtsToggle.checked));
rtsToggle.addEventListener("change", () => setSignals(dtrToggle.checked, rtsToggle.checked));

// ---------------------------------------------------------------------------
// Chip info
// ---------------------------------------------------------------------------
chipInfoBtn.addEventListener("click", async () => {
  await withExclusiveTransport(async (loader) => {
    const chipName = await loader.main("no_reset");
    infoChip.textContent = chipName;
    footerMsg.textContent = `Chip detected: ${chipName}`;
  });
});

// ---------------------------------------------------------------------------
// Flash file selection
//
// A plain <input type="file" webkitdirectory> picker is used instead of the
// File System Access API's showDirectoryPicker(), since it works the same
// way across Chrome and Edge without extra permission prompts.
// ---------------------------------------------------------------------------
const folderInput = document.createElement("input");
folderInput.type = "file";
folderInput.webkitdirectory = true;
folderInput.style.display = "none";
document.body.appendChild(folderInput);

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".bin";
fileInput.style.display = "none";
document.body.appendChild(fileInput);

pickFolderBtn.addEventListener("click", () => folderInput.click());
addFileBtn.addEventListener("click", () => fileInput.click());

folderInput.addEventListener("change", () => {
  const files = Array.from(folderInput.files);
  const flashArgsFile = files.find((f) => f.webkitRelativePath.endsWith("/flash_args") || f.name === "flash_args");

  if (!flashArgsFile) {
    folderHint.textContent = "No flash_args file found in that folder.";
    return;
  }

  flashArgsFile.text().then((text) => {
    try {
      const parsed = parseFlashArgs(text);

      // Apply the flash settings line (--flash_mode/--flash_freq/--flash_size).
      if (parsed.flashMode) flashModeSelect.value = parsed.flashMode;
      if (parsed.flashFreq) flashFreqSelect.value = parsed.flashFreq;
      if (parsed.flashSize) flashSizeSelect.value = parsed.flashSize;

      // Resolve each referenced file against the folder's contents.
      const missing = [];
      const queue = [];
      for (const entry of parsed.entries) {
        const match = files.find((f) => f.webkitRelativePath.endsWith("/" + entry.relPath));
        if (!match) {
          missing.push(entry.relPath);
          continue;
        }
        queue.push({ offset: entry.offset, name: entry.relPath, size: match.size, file: match });
      }

      flashQueue = queue;
      renderFlashTable();

      if (missing.length) {
        folderHint.textContent = `Loaded ${queue.length} file(s) from flash_args. Missing: ${missing.join(", ")}`;
      } else {
        folderHint.textContent = `Loaded ${queue.length} file(s) from flash_args.`;
      }
      flashBtn.disabled = !port || flashQueue.length === 0;
    } catch (err) {
      folderHint.textContent = `Could not parse flash_args: ${err.message}`;
    }
  });
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const offset = prompt(`Flash offset for ${file.name} (e.g. 0x10000):`, "0x10000");
  if (offset === null) return;
  flashQueue.push({ offset: offset.trim(), name: file.name, size: file.size, file });
  renderFlashTable();
  flashBtn.disabled = !port || flashQueue.length === 0;
  fileInput.value = "";
});

// Parses an ESP-IDF build/flash_args file:
//   line 1: --flash_mode dio --flash_freq 80m --flash_size 8MB
//   remaining lines: "<offset> <relative/path/to/file.bin>"
function parseFlashArgs(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("file is empty");

  const settings = {};
  const settingsRegex = /--(\S+)\s+(\S+)/g;
  let m;
  while ((m = settingsRegex.exec(lines[0])) !== null) {
    settings[m[1]] = m[2];
  }

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length < 2) continue;
    const [offset, ...rest] = parts;
    entries.push({ offset, relPath: rest.join(" ") });
  }

  return {
    flashMode: settings.flash_mode,
    flashFreq: settings.flash_freq,
    flashSize: settings.flash_size,
    entries,
  };
}

function renderFlashTable() {
  flashTableBody.innerHTML = "";
  flashQueue.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" value="${item.offset}" data-idx="${idx}" class="offset-input" /></td>
      <td>${item.name}</td>
      <td>${formatBytes(item.size)}</td>
      <td><button class="secondary remove-btn" data-idx="${idx}">&times;</button></td>
    `;
    flashTableBody.appendChild(tr);
  });

  flashTableBody.querySelectorAll(".offset-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      flashQueue[+e.target.dataset.idx].offset = e.target.value.trim();
    });
  });
  flashTableBody.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      flashQueue.splice(+e.target.dataset.idx, 1);
      renderFlashTable();
      flashBtn.disabled = !port || flashQueue.length === 0;
    });
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Flashing / erasing — hands the port over to esptool-js for the duration
// ---------------------------------------------------------------------------

// Pauses the terminal's read loop, builds a Transport + ESPLoader around the
// already-open port, runs `work(loader, transport)`, then always tears the
// loader down and resumes the terminal — even if `work` throws.
async function withExclusiveTransport(work) {
  if (!port || isFlashing) return;
  isFlashing = true;
  flashBtn.disabled = true;
  eraseFlashBtn.disabled = true;
  chipInfoBtn.disabled = true;

  await stopReading();

  const transport = new Transport(port, true);
  const loader = new ESPLoader({
    transport,
    baudrate: parseInt(baudSelect.value, 10),
    terminal: espLoaderTerminal,
  });

  try {
    await work(loader, transport);
  } catch (err) {
    console.error(err);
    footerMsg.textContent = `Error: ${err.message}`;
    writeTerminal(`\n[error] ${err.message}\n`);
  } finally {
    try {
      await transport.disconnect();
    } catch (_) {
      /* ignore — port may already be in a torn-down state */
    }
    isFlashing = false;
    chipInfoBtn.disabled = !port;
    flashBtn.disabled = !port || flashQueue.length === 0;
    eraseFlashBtn.disabled = !port;

    // esptool-js may leave the port closed after disconnect(); reopen it
    // so the terminal can keep monitoring the board.
    try {
      if (port && !port.readable) {
        await port.open({ baudRate: parseInt(baudSelect.value, 10) });
      }
      startReading();
    } catch (err) {
      console.warn("Could not resume monitor mode:", err);
    }
  }
}

flashBtn.addEventListener("click", async () => {
  if (flashQueue.length === 0) return;

  progressWrap.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressText.textContent = "Preparing...";

  await withExclusiveTransport(async (loader) => {
    footerMsg.textContent = "Connecting to bootloader...";
    const chipName = await loader.main();
    infoChip.textContent = chipName;
    writeTerminal(`\n[esptool] Connected to ${chipName}\n`);

    const fileArray = [];
    for (const item of flashQueue) {
      const buf = await item.file.arrayBuffer();
      fileArray.push({ data: new Uint8Array(buf), address: parseInt(item.offset, 16) });
    }

    await loader.writeFlash({
      fileArray,
      flashMode: flashModeSelect.value,
      flashFreq: flashFreqSelect.value,
      flashSize: flashSizeSelect.value,
      eraseAll: eraseAllCheck.checked,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const pct = Math.round((written / total) * 100);
        progressFill.style.width = `${pct}%`;
        progressText.textContent = `File ${fileIndex + 1}/${fileArray.length}: ${pct}%`;
      },
    });

    footerMsg.textContent = "Flash complete. Resetting board...";
    await loader.after("hard_reset");
    progressText.textContent = "Done";
    footerMsg.textContent = "Flash complete.";
  });
});

eraseFlashBtn.addEventListener("click", async () => {
  if (!confirm("This will erase the ENTIRE flash on the board. Continue?")) return;
  progressWrap.classList.remove("hidden");
  progressFill.style.width = "0%";
  progressText.textContent = "Erasing...";

  await withExclusiveTransport(async (loader) => {
    await loader.main();
    await loader.eraseFlash();
    progressFill.style.width = "100%";
    progressText.textContent = "Erased";
    footerMsg.textContent = "Flash erased.";
    await loader.after("hard_reset");
  });
});
