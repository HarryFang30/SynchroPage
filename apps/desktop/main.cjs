const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PAGEPAIR_DESKTOP_PORT || 8765);
const PORT_SCAN_LIMIT = Number(process.env.PAGEPAIR_DESKTOP_PORT_SCAN_LIMIT || 20);
const BACKEND_START_TIMEOUT_MS = Number(process.env.PAGEPAIR_BACKEND_START_TIMEOUT_MS || 30_000);

let mainWindow = null;
let backendProcess = null;
let backendLogPath = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.on("ready", async () => {
  Menu.setApplicationMenu(null);
  try {
    const webRoot = resolveWebRoot();
    ensureBuiltWebRoot(webRoot);
    const backend = await ensureBackend(webRoot);
    mainWindow = createMainWindow(backend.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("PagePair Reader failed to start", message);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  stopBackend();
});

process.on("exit", () => {
  stopBackend();
});

function createMainWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 760,
    title: "PagePair Reader",
    autoHideMenuBar: true,
    backgroundColor: "#f7f4ec",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith(url)) return { action: "allow" };
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl.startsWith(url)) return;
    event.preventDefault();
    shell.openExternal(targetUrl);
  });

  if (process.env.PAGEPAIR_DESKTOP_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  void win.loadURL(url);
  return win;
}

async function ensureBackend(webRoot) {
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = DEFAULT_PORT + offset;
    const health = await getBackendHealth(port);
    if (health.ok) {
      return { port, url: `http://${HOST}:${port}/`, external: true };
    }
    const occupied = await isPortOccupied(port);
    if (occupied) continue;

    startBackend(port, webRoot);
    await waitForBackend(port);
    return { port, url: `http://${HOST}:${port}/`, external: false };
  }

  throw new Error(`No available PagePair backend port found from ${DEFAULT_PORT} to ${DEFAULT_PORT + PORT_SCAN_LIMIT - 1}.`);
}

function startBackend(port, webRoot) {
  const backendBinary = resolveBackendBinary();
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: "1"
  };

  let command;
  let args;
  let cwd;

  if (backendBinary) {
    command = backendBinary;
    args = ["--host", HOST, "--port", String(port), "--web-root", webRoot];
    cwd = path.dirname(backendBinary);
  } else {
    if (app.isPackaged) {
      throw new Error("Packaged app is missing the bundled PagePair backend. Rebuild with `npm --prefix apps/desktop run dist`.");
    }
    const repoRoot = resolveRepoRoot();
    const python = process.env.PAGEPAIR_PYTHON || "python3";
    command = python;
    args = ["-m", "pdf_agent.server.web_app", "--host", HOST, "--port", String(port), "--web-root", webRoot];
    cwd = repoRoot;
    env.PYTHONPATH = [path.join(repoRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }

  backendProcess = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  backendProcess.on("error", (error) => {
    appendBackendLog(`backend process error: ${error.message}\n`);
  });
  backendProcess.stdout.on("data", (chunk) => appendBackendLog(chunk));
  backendProcess.stderr.on("data", (chunk) => appendBackendLog(chunk));
  backendProcess.on("exit", (code, signal) => {
    appendBackendLog(`backend exited: code=${code ?? "null"} signal=${signal ?? "null"}\n`);
    backendProcess = null;
  });
}

function stopBackend() {
  if (!backendProcess) return;
  const child = backendProcess;
  backendProcess = null;
  if (!child.killed) child.kill("SIGTERM");
}

function resolveRepoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function resolveWebRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "web-dist");
  return path.resolve(__dirname, "..", "web", "dist");
}

function resolveBackendBinary() {
  const candidates = [];
  if (process.env.PAGEPAIR_BACKEND_BINARY) candidates.push(process.env.PAGEPAIR_BACKEND_BINARY);
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, "backend", "pagepair-backend"));
  candidates.push(path.resolve(__dirname, "bin", "pagepair-backend"));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureBuiltWebRoot(webRoot) {
  if (fs.existsSync(path.join(webRoot, "index.html"))) return;
  throw new Error(`Built web UI not found at ${webRoot}. Run \`npm --prefix apps/web run build\` first.`);
}

async function waitForBackend(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BACKEND_START_TIMEOUT_MS) {
    if (backendProcess?.exitCode !== null && backendProcess?.exitCode !== undefined) break;
    const health = await getBackendHealth(port);
    if (health.ok) return;
    await delay(300);
  }
  throw new Error(`PagePair backend did not become healthy on ${HOST}:${port}. See ${getBackendLogPath()} for details.`);
}

function getBackendHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: HOST,
        port,
        path: "/api/health",
        timeout: 1000
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ ok: response.statusCode === 200 && parsed?.service === "pdf-agent" });
          } catch {
            resolve({ ok: false });
          }
        });
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false });
    });
    request.on("error", () => resolve({ ok: false }));
  });
}

function isPortOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackendLogPath() {
  if (backendLogPath) return backendLogPath;
  const logDir = app.getPath("logs");
  fs.mkdirSync(logDir, { recursive: true });
  backendLogPath = path.join(logDir, "backend.log");
  return backendLogPath;
}

function appendBackendLog(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const line = `[${new Date().toISOString()}] ${text}`;
  fs.appendFile(getBackendLogPath(), line, () => {});
}
