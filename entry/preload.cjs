const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ntr', {
  submit: (text) => ipcRenderer.invoke('submit', text),
  pick: (choice) => ipcRenderer.invoke('pick', choice),
  cancel: () => ipcRenderer.send('cancel'),
  history: () => ipcRenderer.invoke('history'),
  lang: () => ipcRenderer.invoke('lang'),
  getHotkey: () => ipcRenderer.invoke('get-hotkey'),
  setHotkey: (acc) => ipcRenderer.invoke('set-hotkey', acc),
  resize: (h) => ipcRenderer.send('resize', h),
  onShow: (cb) => ipcRenderer.on('show', () => cb()),
  micData: (buf) => ipcRenderer.send('mic-data', buf),
  micError: (msg) => ipcRenderer.send('mic-error', msg),
});
