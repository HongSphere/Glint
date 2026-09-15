'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const {
  getConfig,
  setConfig,
  resetConfig,
  setPendingGitLab,
  setPendingAI,
  normalizeHost,
} = require('./config');
const { initUpdater, checkForUpdates, quitAndInstall, getUpdateState } = require('./updater');
const { listMergeRequests, getMergeRequest, testGitLab, listProjects } = require('./gitlab');
const { testAI, runReview, stopReview, postReviewToGitLab } = require('./review');
const { listSkills, resolveSkill, skillRoots } = require('./skills');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 960,
    minHeight: 700,
    title: 'Glint',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  initUpdater(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: '检查更新…',
                click: () => checkForUpdates(true),
              },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: '编辑',
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
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(isMac
      ? []
      : [
          {
            label: '帮助',
            submenu: [
              {
                label: '检查更新…',
                click: () => checkForUpdates(true),
              },
            ],
          },
        ]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerIpc() {
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_e, partial) => {
    setConfig(partial || {});
    return getConfig();
  });
  ipcMain.handle('config:reset', () => {
    resetConfig();
    return getConfig();
  });

  ipcMain.handle('gitlab:test', async (_e, form) => {
    setPendingGitLab(form?.gitlab || null);
    try {
      return await testGitLab();
    } finally {
      setPendingGitLab(null);
    }
  });
  ipcMain.handle('gitlab:listProjects', async (_e, opts) => {
    setPendingGitLab(opts?.gitlab || null);
    try {
      const projects = await listProjects(opts || {});
      const cfg = getConfig();
      // only persist project list cache when credentials match saved config
      const saved = cfg?.gitlab || {};
      const form = opts?.gitlab || {};
      const sameHost = !form.host || normalizeHost(form.host) === normalizeHost(saved.host || '');
      const sameToken = !form.token || form.token === saved.token;
      if (sameHost && sameToken && saved.host && saved.token) {
        const token = saved.token;
        const tokenSig = token.length >= 4 ? `${token.length}:${token.slice(-4)}` : String(token.length);
        setConfig({
          cache: {
            projects,
            projectsHost: saved.host,
            projectsTokenSig: tokenSig,
            projectsAt: Date.now(),
          },
        });
      }
      return projects;
    } finally {
      setPendingGitLab(null);
    }
  });
  ipcMain.handle('gitlab:listMrs', async (_e, opts) => listMergeRequests(opts || {}));
  ipcMain.handle('gitlab:getMr', async (_e, iid) => getMergeRequest(iid));

  ipcMain.handle('ai:test', async (_e, form) => {
    setPendingAI(form?.ai || null);
    try {
      return await testAI();
    } finally {
      setPendingAI(null);
    }
  });

  ipcMain.handle('skills:list', async () => {
    const cfg = getConfig();
    return listSkills(cfg?.review?.skillDir || '').map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      path: s.path,
      builtin: Boolean(s.builtin),
    }));
  });
  ipcMain.handle('skills:get', async (_e, id) => {
    const cfg = getConfig();
    const sk = resolveSkill({ skillId: id, skillDir: cfg?.review?.skillDir || '' });
    if (!sk) return null;
    return {
      id: sk.id,
      name: sk.name,
      description: sk.description,
      path: sk.path,
      builtin: Boolean(sk.builtin),
      bodyPreview: sk.body.slice(0, 800),
    };
  });
  ipcMain.handle('skills:roots', async () => {
    const cfg = getConfig();
    return skillRoots(cfg?.review?.skillDir || '');
  });
  ipcMain.handle('skills:setDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择技能目录（仅一个）',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const dir = res.filePaths[0];
    setConfig({ review: { skillDir: dir } });
    return dir;
  });
  ipcMain.handle('skills:clearDir', async () => {
    setConfig({ review: { skillDir: '' } });
    return true;
  });

  ipcMain.handle('review:run', async (_e, opts) => {
    const result = await runReview(opts || {}, (progress) => {
      send('review:progress', progress);
    });
    return result;
  });
  ipcMain.handle('review:stop', async () => stopReview());

  ipcMain.handle('review:post', async (_e, payload) => postReviewToGitLab(payload || {}));

  ipcMain.handle('update:check', async (_e, interactive) => {
    checkForUpdates(Boolean(interactive));
    return getUpdateState();
  });
  ipcMain.handle('update:install', async () => {
    quitAndInstall();
    return true;
  });
  ipcMain.handle('update:state', async () => getUpdateState());

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
  }));

  ipcMain.handle('dialog:pickJson', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择配置文件',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
}

app.whenReady().then(() => {
  buildMenu();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
