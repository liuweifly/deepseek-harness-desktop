'use strict';

// DeepSeek 桌面版 —— 主进程
// 启动时自动拉起 dsh Harness 服务(若 3080 已有实例则直接复用),
// 并在原生窗口中打开 Harness Web UI。

const { app, BrowserWindow, Menu, shell, dialog, nativeTheme } = require('electron');
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

// 「统一标题栏」模式(macOS):隐藏原生标题栏,红绿灯悬浮在侧边栏顶部,
// 网页自身的主头部直接成为 App 头部 —— 即 Claude Code App 的样式。
// 通过注入的拖拽区拖动窗口,View 菜单可随时切回传统标题栏。
let unifiedTitleBar = true;

// 注入统一标题栏辅助:侧边栏顶部让位 + 拖拽区(幂等,可安全重复执行)
const INJECT_CHROME_JS = `(() => {
  if (document.getElementById('ds-desktop-chrome')) return;
  // 1) 找到左上角占满整列的侧边栏容器(约 280px 宽),顶部让位给红绿灯
  const sidebar = [...document.querySelectorAll('body div')].find((el) => {
    const r = el.getBoundingClientRect();
    return r.left === 0 && r.top === 0 && r.width > 200 && r.width < 420 && r.height > 400;
  });
  let padded = false;
  if (sidebar && !sidebar.dataset.dsPadded) {
    sidebar.dataset.dsPadded = '1';
    sidebar.style.paddingTop = '46px';
    padded = true;
  }
  // 2) 拖拽区:侧边栏顶部的空位(宽 280 × 高 46);主区顶部一条 10px 细条
  if (padded) {
    const strip = document.createElement('div');
    strip.id = 'ds-desktop-chrome';
    strip.style.cssText = 'position:fixed;top:0;left:0;width:280px;height:46px;z-index:2147483647;-webkit-app-region:drag;';
    document.documentElement.appendChild(strip);
  }
  const main = document.createElement('div');
  main.id = 'ds-desktop-chrome-main';
  main.style.cssText = 'position:fixed;top:0;left:280px;right:0;height:10px;z-index:2147483646;-webkit-app-region:drag;';
  document.documentElement.appendChild(main);
})()`;

const REMOVE_CHROME_JS = `(() => {
  document.getElementById('ds-desktop-chrome')?.remove();
  document.getElementById('ds-desktop-chrome-main')?.remove();
  [...document.querySelectorAll('[data-ds-padded]')].forEach((el) => {
    delete el.dataset.dsPadded;
    el.style.paddingTop = '';
  });
})()`;

function applyUnifiedChrome(win) {
  win.webContents.executeJavaScript(INJECT_CHROME_JS, true).catch(() => {});
}

function removeUnifiedChrome(win) {
  win.webContents.executeJavaScript(REMOVE_CHROME_JS, true).catch(() => {});
}

function toggleTitleBar(win) {
  unifiedTitleBar = !unifiedTitleBar;
  win.setTitleBarStyle(unifiedTitleBar ? 'hiddenInset' : 'default');
  if (unifiedTitleBar) {
    if (typeof win.setTrafficLightPosition === 'function') {
      win.setTrafficLightPosition({ x: 14, y: 16 });
    }
    applyUnifiedChrome(win);
  } else {
    removeUnifiedChrome(win);
  }
}

function createWindow() {
  // 窗口底色跟随系统深浅色,避免加载瞬间闪屏
  const initialBg = nativeTheme.shouldUseDarkColors ? '#101014' : '#f9fafb';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'DeepSeek',
    backgroundColor: initialBg,
    titleBarStyle: 'hiddenInset', // 统一标题栏:无原生条,红绿灯悬浮
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(APP_URL);

  // 页面加载完成后注入统一标题栏辅助,并按页面实际背景色同步窗口底色
  mainWindow.webContents.on('did-finish-load', () => {
    if (unifiedTitleBar) applyUnifiedChrome(mainWindow);
    mainWindow.webContents
      .executeJavaScript('getComputedStyle(document.body).backgroundColor', true)
      .then((color) => {
        if (typeof color === 'string' && color.startsWith('rgb')) {
          mainWindow.setBackgroundColor(color);
        }
      })
      .catch(() => {});
  });

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
        {
          label: '切换标题栏样式 (统一 ⇄ 传统)',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || mainWindow;
            if (win) toggleTitleBar(win);
          },
        },
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
