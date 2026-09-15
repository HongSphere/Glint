'use strict';

const path = require('path');
const { app } = require('electron');
const Store = require('electron-store');

// App-level machine config (not reviewed by AI): tokens, hosts, update owner.
const store = new Store({
  name: 'ai-mr-review-config',
  cwd: app.getPath('userData'),
  defaults: {
    gitlab: {
      host: '',
      token: '',
      projectPath: '',
    },
    ai: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      apiKey: '',
      model: 'ark-code-latest',
    },
    review: {
      skipInline: false,
      skillId: 'gitlab-mr-review',
      skillDir: '',
    },
    update: {
      owner: 'HongSphere',
      repo: 'Glint',
      channel: 'latest',
    },
    ui: {
      theme: 'system',
    },
    cache: {
      projects: [],
      projectsHost: '',
      projectsTokenSig: '',
      projectsAt: 0,
    },
  },
});

function getConfig() {
  return store.store;
}

function setConfig(partial) {
  const current = store.store;
  const next = deepMerge(current, partial || {});
  store.store = next;
  return store.store;
}

function resetConfig() {
  store.clear();
  return store.store;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Temporary form values for connect/load without persisting until 保存
let pendingGitLab = null;
let pendingAI = null;

function setPendingGitLab(partial) {
  pendingGitLab = partial || null;
}
function setPendingAI(partial) {
  pendingAI = partial || null;
}

function getGitLabConfig() {
  const g = store.get('gitlab') || {};
  const base = {
    host: normalizeHost(g.host || ''),
    token: (g.token || '').trim(),
    projectPath: (g.projectPath || '').trim(),
  };
  if (!pendingGitLab) return base;
  return {
    host: normalizeHost(pendingGitLab.host || base.host),
    token: (pendingGitLab.token || base.token || '').trim(),
    projectPath: (pendingGitLab.projectPath || base.projectPath || '').trim(),
  };
}

function getAIConfig() {
  const a = store.get('ai') || {};
  const base = {
    baseUrl: (a.baseUrl || 'https://ark.cn-beijing.volces.com/api/coding/v3').replace(/\/+$/, ''),
    apiKey: (a.apiKey || '').trim(),
    model: a.model || 'ark-code-latest',
  };
  if (!pendingAI) return base;
  return {
    baseUrl: (pendingAI.baseUrl || base.baseUrl || '').replace(/\/+$/, ''),
    apiKey: (pendingAI.apiKey || base.apiKey || '').trim(),
    model: pendingAI.model || base.model,
  };
}

function getReviewOptions() {
  const r = store.get('review') || {};
  return {
    skipInline: Boolean(r.skipInline),
    skillId: r.skillId || 'gitlab-mr-review',
    skillDir: r.skillDir || '',
  };
}

function getUpdateRepo() {
  const u = store.get('update') || {};
  return {
    owner: u.owner || 'HongSphere',
    repo: u.repo || 'Glint',
  };
}

function normalizeHost(host) {
  let h = (host || '').trim();
  if (!h) return '';
  h = h.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return h;
}

module.exports = {
  store,
  getConfig,
  setConfig,
  resetConfig,
  getGitLabConfig,
  getAIConfig,
  getReviewOptions,
  getUpdateRepo,
  normalizeHost,
  setPendingGitLab,
  setPendingAI,
};
