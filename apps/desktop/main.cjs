const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const development = process.env.DBILDO_DEV === '1';
let backend;
let ownsBackend = false;

function healthy() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:4317/health', (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

async function waitForBackend() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await healthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Локальный backend не запустился');
}

async function createWindow() {
  if (!(await healthy())) {
    const executable = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    backend = spawn(executable, [path.resolve(__dirname, '../server/src/index.ts')], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DBILDO_HOST: '127.0.0.1' },
      stdio: 'inherit'
    });
    ownsBackend = true;
  }
  await waitForBackend();
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: '#10151c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (development) await window.loadURL('http://127.0.0.1:5173');
  else await window.loadFile(path.resolve(__dirname, '../../dist/ui/index.html'));
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('DBildo', String(error));
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => { if (ownsBackend && backend && !backend.killed) backend.kill('SIGTERM'); });
