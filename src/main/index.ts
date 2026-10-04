import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { DEFAULT_SETTINGS, VERSION, validateSettings } from "../shared/settings";
import { enableSourceAdapter } from "./source-adapter";
const electron = require("electron");
const { app, ipcMain } = electron;
const resources = process.resourcesPath;
const modDir = path.join(resources, "lolkamod");
const original = path.join(resources, "_app.asar");
const config = JSON.parse(fs.readFileSync(path.join(modDir, "config.json"), "utf8"));
const hostMain = config.hostMain ?? "dist-js/main.js";
const hostPreloadPath = config.hostPreload ?? "dist-js/preload.js";
if (hostMain !== "dist-js/main.js" || hostPreloadPath !== "dist-js/preload.js") throw new Error("Unsupported desktop entry layout");
const hostPackage = JSON.parse(fs.readFileSync(path.join(original, "package.json"), "utf8"));
app.getVersion = () => hostPackage.version;
const testMode = config.testMode === true;
const disabled = process.argv.includes("--lolkamod-disable") || config.baseline === true;
if (testMode) {
  app.setPath("userData", config.userData);
  app.setPath("sessionData", config.userData);
  app.setAsDefaultProtocolClient = () => false;
  app.removeAsDefaultProtocolClient = () => false;
  app.isDefaultProtocolClient = () => true;
  app.setLoginItemSettings = () => {};
  app.setAppUserModelId = () => {};
}
app.setAppPath(original);
const metadata: Record<string, unknown> = { version: VERSION, testMode, disabled,
  electron: process.versions.electron, hostVersion: hostPackage.version, updaterPaused: true, windows: [], settingsReads: 0, settingsWrites: 0 };
const adapterReports = new Map<number, Record<string, unknown>>();
function evidence() {
  if (!testMode) return;
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, "runtime.json"), JSON.stringify(metadata, null, 2));
}
const settingsDir = path.join(app.getPath("userData"), "lolkamod");
const settingsFile = path.join(settingsDir, "settings.json");
function readSettings() {
  try { return validateSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8"))); }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function allowed(event: any) {
  // An iframe or another origin cannot invoke a privileged mod endpoint.
  try { return event.senderFrame === event.sender.mainFrame &&
    new URL(event.senderFrame.url).origin === "https://lolka.app"; } catch { return false; }
}
if (!disabled) {
  ipcMain.on("lolkamod:settings:read", (event: any) => {
    event.returnValue = allowed(event) ? readSettings() : null;
    metadata.settingsReads = Number(metadata.settingsReads) + 1; evidence();
  });
  ipcMain.handle("lolkamod:settings:write", (event: any, value: unknown) => {
    if (!allowed(event)) throw new Error("Forbidden sender");
    const settings = validateSettings(value);
    fs.mkdirSync(settingsDir, { recursive: true });
    const temp = settingsFile + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(settings), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, settingsFile);
    metadata.settingsWrites = Number(metadata.settingsWrites) + 1; evidence();
    return settings;
  });
  ipcMain.on("lolkamod:diagnostics", (event: any) => {
    event.returnValue = allowed(event) ? { testMode, sourceAdapter: adapterReports.get(event.sender.id) ?? { status: "not-started" } } : null;
  });
}

// Retain the host updater object and events, but prevent replacing this prototype.
// A no-update result also lets the normal splash -> main-window path complete.
const load = (Module as any)._load;
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
  const exports = load.call(this, request, parent, isMain);
  if (request === "electron" || request === "electron/main") return patchedElectron;
  if (request === "electron-updater" && exports.autoUpdater && !exports.autoUpdater.__lolkamodPaused) {
    const updater = exports.autoUpdater;
    Object.defineProperty(updater, "__lolkamodPaused", { value: true });
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.checkForUpdates = async () => {
      updater.emit("checking-for-update");
      const updateInfo = { version: app.getVersion(), files: [], releaseDate: new Date().toISOString() };
      updater.emit("update-not-available", updateInfo);
      return { updateInfo, isUpdateAvailable: false };
    };
    updater.downloadUpdate = async () => { throw new Error("LolkaMod prototype: updater paused"); };
    updater.quitAndInstall = () => {};
  }
  return exports;
};

const OriginalBrowserWindow = electron.BrowserWindow;
class ModBrowserWindow extends OriginalBrowserWindow {
  constructor(options: any = {}) {
    const prefs = options.webPreferences ?? {};
    const hostPreload = prefs.preload && path.normalize(prefs.preload) === path.normalize(path.join(original, hostPreloadPath));
    const next = { ...options, ...(testMode ? { show: false } : {}),
      webPreferences: { ...prefs, ...(!disabled && hostPreload ? { preload: path.join(modDir, "preload.js") } : {}) } };
    super(next);
    const webContentsId = this.webContents.id;
    if (!disabled && hostPreload) {
      // Hold loadURL until Fetch is armed, before the original main starts navigation.
      const adapterReady = enableSourceAdapter(this.webContents, result => {
        adapterReports.set(webContentsId, { ...adapterReports.get(webContentsId), ...result });
        metadata.sourceAdapters = Object.fromEntries(adapterReports); evidence();
        // Only compatibility metadata is persisted, never response bodies or account data.
        try {
          const reportFile = path.join(modDir, "compatibility.json"), temp = reportFile + ".tmp";
          fs.writeFileSync(temp, JSON.stringify({ ...adapterReports.get(webContentsId), hostVersion: hostPackage.version, modVersion: VERSION }, null, 2));
          fs.renameSync(temp, reportFile);
        } catch { /* Read-only resources must not prevent the original app from loading. */ }
      });
      const originalLoadURL = this.loadURL.bind(this);
      this.loadURL = async (...args: unknown[]) => { await adapterReady; return originalLoadURL(...args); };
    }
    if (testMode) {
      this.show = () => {}; this.showInactive = () => {}; this.focus = () => {};
      this.webContents.openDevTools = () => {};
    }
    const actual = this.webContents.getLastWebPreferences();
    const windowInfo: Record<string, unknown> = { id: this.id, hostPreload: !!hostPreload,
      contextIsolation: actual.contextIsolation, sandbox: actual.sandbox, nodeIntegration: actual.nodeIntegration,
      webSecurity: actual.webSecurity, modPreload: !disabled && !!hostPreload, origin: null };
    (metadata.windows as unknown[]).push(windowInfo);
    this.webContents.on("did-finish-load", () => {
      try { windowInfo.origin = new URL(this.webContents.getURL()).origin; } catch { windowInfo.origin = "unknown"; }
      evidence();
    });
    this.webContents.on("preload-error", () => { windowInfo.preloadError = true; evidence(); });
    evidence();
  }
}
// Electron 40 exports BrowserWindow through a non-configurable getter.
// Intercept the module result rather than redefining that property.
const patchedElectron = new Proxy(electron, { get(target, key, receiver) {
  return key === "BrowserWindow" ? ModBrowserWindow : Reflect.get(target, key, receiver);
}});
metadata.isolatedProfile = testMode;
evidence();
try { require(path.join(original, hostMain)); }
catch (error) {
  metadata.hostMainFailed = true; evidence();
  throw error;
}
