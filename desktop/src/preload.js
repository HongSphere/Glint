'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  testGitLab: (form) => ipcRenderer.invoke('gitlab:test', form),
  listProjects: (opts) => ipcRenderer.invoke('gitlab:listProjects', opts),
  listMergeRequests: (opts) => ipcRenderer.invoke('gitlab:listMrs', opts),
  getMergeRequest: (iid) => ipcRenderer.invoke('gitlab:getMr', iid),

  testAI: (form) => ipcRenderer.invoke('ai:test', form),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  getSkill: (id) => ipcRenderer.invoke('skills:get', id),
  skillRoots: () => ipcRenderer.invoke('skills:roots'),
  setSkillDir: () => ipcRenderer.invoke('skills:setDir'),
  clearSkillDir: () => ipcRenderer.invoke('skills:clearDir'),

  runReview: (opts) => ipcRenderer.invoke('review:run', opts),
  stopReview: () => ipcRenderer.invoke('review:stop'),
  postReview: (payload) => ipcRenderer.invoke('review:post', payload),

  checkUpdate: (interactive) => ipcRenderer.invoke('update:check', interactive),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  updateState: () => ipcRenderer.invoke('update:state'),

  appInfo: () => ipcRenderer.invoke('app:info'),

  onReviewProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('review:progress', handler);
    return () => ipcRenderer.removeListener('review:progress', handler);
  },
  onUpdateState: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update:state', handler);
    return () => ipcRenderer.removeListener('update:state', handler);
  },
});
