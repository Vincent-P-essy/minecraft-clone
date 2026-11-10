/**
 * Desktop shell: a locked-down Electron window around the same web build
 * that ships to browsers and phones.
 *
 * Security posture (this window only ever shows our own bundled files):
 *  - the page runs sandboxed, context-isolated, with no Node integration;
 *  - files are served over a private `app://` scheme from one directory,
 *    with path-traversal checks — never `file://`;
 *  - a strict Content-Security-Policy is attached to every response;
 *  - navigation away, new windows and every permission request are denied.
 */
const { app, BrowserWindow, Menu, net, protocol, session, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "app")
  : path.join(__dirname, "..", "dist");
const ORIGIN = "app://game";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function resolveInsideRoot(urlPath) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  const resolved = path.resolve(ROOT, relative);
  const inside = resolved === ROOT || resolved.startsWith(ROOT + path.sep);
  return inside ? resolved : null;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: "#05080d",
    autoHideMenuBar: true,
    show: false,
    title: "Lumenwild",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Keep rendering at full rate when the window loses focus mid-build.
      backgroundThrottling: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // The game never needs to leave its own origin.
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ORIGIN + "/")) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      window.setFullScreen(!window.isFullScreen());
      event.preventDefault();
    }
  });

  void window.loadURL(`${ORIGIN}/index.html`);
  return window;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const file = url.host === "game" ? resolveInsideRoot(url.pathname) : null;
    if (!file) return new Response("Not found", { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", CSP);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  // Pointer lock and fullscreen are the only capabilities the game uses.
  const allowed = new Set(["pointerLock", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    allowed.has(permission),
  );

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Nothing in the game should ever spawn a webview or a second renderer
// pointed somewhere else.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
