// The only bridge between the UI and the operating system. Keep it small.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openPdfs: (multiple) => ipcRenderer.invoke('dialog:open-pdfs', { multiple }),
  openImage: () => ipcRenderer.invoke('dialog:open-image'),
  savePdfAs: (suggestedName, data) => ipcRenderer.invoke('dialog:save-pdf', { suggestedName, data }),
  writePdf: (filePath, data) => ipcRenderer.invoke('file:write-pdf', { filePath, data }),
  initialFile: () => ipcRenderer.invoke('app:initial-file'),
  listSignatures: () => ipcRenderer.invoke('sig:list'),
  saveSignature: (dataUrl) => ipcRenderer.invoke('sig:save', dataUrl),
  deleteSignature: (id) => ipcRenderer.invoke('sig:delete', id),
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  onMenu: (cb) => {
    const h = (_e, cmd) => cb(cmd);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
  onOpenFile: (cb) => {
    const h = (_e, file) => cb(file);
    ipcRenderer.on('app:open-file', h);
    return () => ipcRenderer.removeListener('app:open-file', h);
  },
  onCloseRequested: (cb) => {
    const h = () => cb();
    ipcRenderer.on('app:close-requested', h);
    return () => ipcRenderer.removeListener('app:close-requested', h);
  },
});
