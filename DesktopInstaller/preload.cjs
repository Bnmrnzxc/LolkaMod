const { contextBridge, ipcRenderer } = require('electron');

const unsubscribeByCallback = new WeakMap();

contextBridge.exposeInMainWorld('installer', Object.freeze({
  getState: () => ipcRenderer.invoke('installer:get-state'),
  chooseFolder: () => ipcRenderer.invoke('installer:choose-folder'),
  inspect: (installation) => ipcRenderer.invoke('installer:inspect', installation),
  action: (request) => ipcRenderer.invoke('installer:action', request),
  openRelease: () => ipcRenderer.invoke('installer:open-release'),
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onProgress expects a callback');
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('installer:progress', listener);
    const unsubscribe = () => {
      ipcRenderer.removeListener('installer:progress', listener);
      unsubscribeByCallback.delete(callback);
    };
    const previous = unsubscribeByCallback.get(callback);
    if (previous) previous();
    unsubscribeByCallback.set(callback, unsubscribe);
    return unsubscribe;
  },
}));
