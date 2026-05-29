const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getPaths: () => ipcRenderer.invoke('get-paths'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', { filePath, content }),
  saveHistoryImage: (fileName, dataUrl) => ipcRenderer.invoke('save-history-image', { fileName, dataUrl }),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),
  toggleInteractivity: () => ipcRenderer.send('toggle-interactivity'),
  quitApp: () => ipcRenderer.send('app-quit'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onInteractivityChanged: (callback) => ipcRenderer.on('interactivity-changed', (event, value) => callback(value))
});
