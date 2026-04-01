const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getState: (root) => ipcRenderer.invoke('get-state', root),
  setManual: (root, key, value) => ipcRenderer.invoke('set-manual', root, key, value),
  saveState: (root, patch) => ipcRenderer.invoke('save-state', root, patch),
  step1: (root) => ipcRenderer.invoke('step1', root),
  step2: (root) => ipcRenderer.invoke('step2', root),
  step4: (root) => ipcRenderer.invoke('step4', root),
  step5: (root) => ipcRenderer.invoke('step5', root),
  ensureDeletedFolder: (root) => ipcRenderer.invoke('ensure-deleted-folder', root),
});
