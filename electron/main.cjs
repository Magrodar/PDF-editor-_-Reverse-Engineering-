// Electron main process: owns the window, native dialogs, file access and the
// signature library. The UI (renderer) never touches the disk directly; it asks
// through the narrow API exposed in preload.cjs.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
let mainWindow = null;
let pendingFile = null; // a PDF passed on the command line / "Open with"

function pdfFromArgv(argv) {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith('.pdf') && fsSync.existsSync(a)) || null;
}

async function readPdf(filePath) {
  const data = await fs.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data) };
}

// ---------- signature library (stored as PNG files in the user's app data) ----------
const sigDir = () => path.join(app.getPath('userData'), 'signatures');

async function listSignatures() {
  await fs.mkdir(sigDir(), { recursive: true });
  const files = (await fs.readdir(sigDir())).filter((f) => f.endsWith('.png'));
  const out = [];
  for (const f of files) {
    const full = path.join(sigDir(), f);
    const stat = await fs.stat(full);
    const b64 = (await fs.readFile(full)).toString('base64');
    out.push({ id: f.replace(/\.png$/, ''), dataUrl: `data:image/png;base64,${b64}`, created: stat.mtimeMs });
  }
  return out.sort((a, b) => b.created - a.created);
}

function safeId(id) {
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) throw new Error('bad id');
  return id;
}

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Nour PDF',
    backgroundColor: '#1f2228',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Links inside PDFs open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) e.preventDefault();
  });

  // Ask the renderer before closing so unsaved work is not lost.
  let allowClose = false;
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:close-requested');
  });
  ipcMain.removeHandler('app:confirm-close');
  ipcMain.handle('app:confirm-close', () => {
    allowClose = true;
    mainWindow.close();
  });

  buildMenu();
}

function send(channel, ...args) {
  if (mainWindow) mainWindow.webContents.send(channel, ...args);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'open') },
        { label: 'Add PDF pages…', click: () => send('menu', 'append') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu', 'saveAs') },
        { label: 'Export selected pages…', click: () => send('menu', 'exportSelected') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu', 'undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => send('menu', 'redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('menu', 'zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('menu', 'zoomOut') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: () => send('menu', 'fitWidth') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(DEV_URL ? [{ role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('dialog:open-pdfs', async (_e, { multiple }) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(readPdf));
  });

  ipcMain.handle('dialog:open-image', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const p = res.filePaths[0];
    const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
    const b64 = (await fs.readFile(p)).toString('base64');
    return { name: path.basename(p), dataUrl: `data:image/${ext};base64,${b64}` };
  });

  ipcMain.handle('dialog:save-pdf', async (_e, { suggestedName, data }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    let target = res.filePath;
    if (!target.toLowerCase().endsWith('.pdf')) target += '.pdf';
    await atomicWrite(target, data);
    return { path: target, name: path.basename(target) };
  });

  ipcMain.handle('file:write-pdf', async (_e, { filePath, data }) => {
    if (!filePath.toLowerCase().endsWith('.pdf')) throw new Error('Only PDF files can be written');
    await atomicWrite(filePath, data);
    return { path: filePath, name: path.basename(filePath) };
  });

  ipcMain.handle('app:initial-file', async () => {
    const f = pendingFile;
    pendingFile = null;
    return f ? readPdf(f) : null;
  });

  ipcMain.handle('sig:list', () => listSignatures());
  ipcMain.handle('sig:save', async (_e, dataUrl) => {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('Signature must be a PNG data URL');
    await fs.mkdir(sigDir(), { recursive: true });
    const id = crypto.randomUUID();
    await fs.writeFile(path.join(sigDir(), `${id}.png`), Buffer.from(m[1], 'base64'));
    return id;
  });
  ipcMain.handle('sig:delete', async (_e, id) => {
    await fs.rm(path.join(sigDir(), `${safeId(id)}.png`), { force: true });
  });
}

// Write to a temp file then rename, so a crash never leaves a half-written PDF.
async function atomicWrite(target, data) {
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, Buffer.from(data));
  await fs.rename(tmp, target);
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingFile = pdfFromArgv(process.argv);

  app.on('second-instance', async (_e, argv) => {
    const f = pdfFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (f) send('app:open-file', await readPdf(f));
    }
  });

  app.on('open-file', async (e, filePath) => {
    // macOS "Open with"
    e.preventDefault();
    if (mainWindow) send('app:open-file', await readPdf(filePath));
    else pendingFile = filePath;
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
