'use strict';

// DeepSeek 桌面版 —— 主进程
// 启动时自动拉起 dsh Harness 服务(若 3080 已有实例则直接复用),
// 并在原生窗口中打开 Harness Web UI。

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3080;
const PORT =
  parseInt(process.env.DSH_DESKTOP_PORT || String(DEFAULT_PORT), 10) || DEFAULT_PORT;
const APP_URL = `http://${HOST}:${PORT}`;
const STARTUP_TIMEOUT_MS = 60 * 1000;

let mainWindow = null;
let serverProc = null;
let serverLogFd = null;
let managed = false;

// 统一用户数据目录名(默认会取 package.json 的 name)
app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeek'));

// ---------------------------------------------------------------- helpers

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function dshEntry() {
  const pkgPath = path.join(
    __dirname,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'package.json'
  );
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh || Object.values(pkg.bin || {})[0];
  return path.join(path.dirname(pkgPath), bin);
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    // dsh 会 fork 子进程承载实际服务,必须按进程组整体终止
    try {
      process.kill(-serverProc.pid, 'SIGTERM');
    } catch (err) {
      /* 进程组已不存在 */
    }
    setTimeout(() => {
      try {
        process.kill(-serverProc.pid, 'SIGKILL');
      } catch (err) {
        /* 已退出 */
      }
    }, 3000).unref();
  }
  if (serverLogFd !== null) {
    try {
      fs.closeSync(serverLogFd);
    } catch (err) {
      /* ignore */
    }
    serverLogFd = null;
  }
}

// ----------------------------------------------------------------- server

async function ensureServer() {
  // 端口已被占用(例如用户正在用网页版)→ 直接复用,退出时不杀掉共享服务
  if (await probe(APP_URL)) return 'attach';

  managed = true;
  const logPath = path.join(app.getPath('userData'), 'server.log');
  serverLogFd = fs.openSync(logPath, 'a');

  serverProc = spawn(
    process.execPath,
    [dshEntry(), '--profile', 'web', '--host', HOST, '--port', String(PORT)],
    {
      cwd: app.getPath('userData'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', serverLogFd, serverLogFd],
      detached: true, // 独立进程组,退出时按组清理所有子进程
    }
  );

  serverProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null && mainWindow) {
      dialog.showErrorBox(
        'DeepSeek 服务已退出',
        `Harness 服务意外退出 (code=${code}, signal=${signal})。\n日志: ${logPath}`
      );
    }
    serverProc = null;
    managed = false;
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(APP_URL)) return 'spawned';
    await sleep(500);
  }
  return 'timeout';
}

// ---------------------------------------------------------------- window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'DeepSeek',
    backgroundColor: '#0d0e13',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(APP_URL);

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
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
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    let status;
    try {
      status = await ensureServer();
    } catch (err) {
      dialog.showErrorBox('DeepSeek 启动失败', `启动 Harness 服务时出错:\n${err && err.message ? err.message : err}`);
      stopServer();
      app.quit();
      return;
    }
    if (status === 'timeout') {
      dialog.showErrorBox(
        'DeepSeek 启动失败',
        `Harness 服务在 ${STARTUP_TIMEOUT_MS / 1000} 秒内未能启动。\n请查看日志: ${path.join(app.getPath('userData'), 'server.log')}`
      );
      stopServer();
      app.quit();
      return;
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    stopServer();
    app.quit();
  });

  app.on('before-quit', () => stopServer());
}
