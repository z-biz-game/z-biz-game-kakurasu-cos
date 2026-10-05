// Desktop shell: the game is a browser build, so Electron serves it over the same
// zero-dependency static server instead of file:// (ES module imports need an origin).
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startServer } = require('../server.cjs');

// 任务栏/Dock 之外的那一枚：Linux 与 Windows 上不给 icon 就是 Electron 的默认图标，
// 于是仓里烘好的母题在桌面壳上根本看不见。macOS 的 Dock 图标来自 .app bundle，不吃这一行。
const ICON = path.join(__dirname, '../icons/icon-512.png');

async function createWindow() {
  const server = await startServer({ port: 0 });
  const { port } = server.address();
  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#101217',
    title: '数和 Kakurasu',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  win.on('closed', () => server.close());
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
