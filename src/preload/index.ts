import { VERSION } from "../shared/settings";
const { contextBridge, ipcRenderer, clipboard } = require("electron");
declare const __RENDERER_SOURCE__: string;

if (process.isMainFrame && location.origin === "https://lolka.app") {
  contextBridge.exposeInMainWorld("LolkaModNative", {
    readSettings: () => ipcRenderer.sendSync("lolkamod:settings:read"),
    writeSettings: (settings: unknown) => ipcRenderer.invoke("lolkamod:settings:write", settings),
    resetSettings: () => ipcRenderer.invoke("lolkamod:settings:reset"),
    checkUpdates: () => ipcRenderer.invoke("lolkamod:updates:check"),
    openRelease: () => ipcRenderer.invoke("lolkamod:updates:open"),
    diagnostics: () => ({ version: VERSION, electron: process.versions.electron,
      sandboxed: process.sandboxed, contextIsolated: process.contextIsolated,
      clipboardAvailable: typeof clipboard?.readText === "function" && typeof clipboard?.writeText === "function",
      updaterPaused: true, injection: "preload-main-world", ...ipcRenderer.sendSync("lolkamod:diagnostics") })
  });
  // Only our build output is evaluated. No eval/IPC capability is exposed to the page.
  contextBridge.executeInMainWorld({ func: new Function(__RENDERER_SOURCE__) });
}
