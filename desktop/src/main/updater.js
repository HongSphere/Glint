'use strict';

const { autoUpdater } = require('electron-updater');
const { getUpdateRepo } = require('./config');

const state = {
  checking: false,
  available: false,
  downloaded: false,
  progress: 0,
  version: null,
  error: null,
  message: '',
};

let initialized = false;
let mainWindow = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function applyFeed() {
  const { owner, repo } = getUpdateRepo();
  autoUpdater.setFeedURL({
    provider: 'github',
    owner,
    repo,
    // releaseType defaults to latest
  });
}

function initUpdater(win) {
  mainWindow = win;
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    state.checking = true;
    state.error = null;
    state.message = '正在检查更新…';
    send('update:state', { ...state });
  });

  autoUpdater.on('update-available', (info) => {
    state.checking = false;
    state.available = true;
    state.version = info?.version || null;
    state.message = `发现新版本 ${state.version || ''}，开始下载…`;
    send('update:state', { ...state });
  });

  autoUpdater.on('update-not-available', () => {
    state.checking = false;
    state.available = false;
    state.message = '已是最新版本';
    send('update:state', { ...state });
  });

  autoUpdater.on('download-progress', (p) => {
    state.progress = Math.round(p.percent || 0);
    state.message = `下载中 ${state.progress}%`;
    send('update:state', { ...state });
  });

  autoUpdater.on('update-downloaded', (info) => {
    state.downloaded = true;
    state.available = true;
    state.progress = 100;
    state.version = info?.version || state.version;
    state.message = '更新已下载，可重启安装';
    send('update:state', { ...state });
  });

  autoUpdater.on('error', (err) => {
    state.checking = false;
    state.error = err?.message || String(err);
    // Dev mode / missing publish config is common; keep quiet unless interactive
    state.message = state.error;
    send('update:state', { ...state });
  });
}

function checkForUpdates(interactive = false) {
  applyFeed();
  if (!initialized) return;
  // In dev, electron-updater often fails without packaged app; still attempt.
  autoUpdater.checkForUpdates().catch((err) => {
    state.error = err?.message || String(err);
    state.message = interactive ? `检查更新失败: ${state.error}` : state.message;
    send('update:state', { ...state });
  });
}

function quitAndInstall() {
  if (state.downloaded) {
    autoUpdater.quitAndInstall(true, true);
  }
}

function getUpdateState() {
  return {
    ...state,
    repo: getUpdateRepo(),
  };
}

module.exports = {
  initUpdater,
  checkForUpdates,
  quitAndInstall,
  getUpdateState,
};
