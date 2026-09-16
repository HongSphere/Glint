/* global window, document, localStorage */
'use strict';

const state = {
  config: null,
  mrs: [],
  mrsAll: [],
  projects: [],
  selectedIid: null,
  lastReview: null,
  appInfo: null,
  themePref: 'system',
  projectComboLocked: false,
  reviewing: false,
};

const $ = (id) => document.getElementById(id);

function formatError(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return mediaDark.matches ? 'dark' : 'light';
}

function applyTheme(pref) {
  state.themePref = pref === 'light' || pref === 'dark' || pref === 'system' ? pref : 'system';
  document.documentElement.setAttribute('data-theme', resolveTheme(state.themePref));
  document.querySelectorAll('input[name="ui-theme"]').forEach((el) => {
    el.checked = el.value === state.themePref;
  });
}

function toggleCustomSkillVisibility() {
  /* no-op: skills come from disk */
}

async function loadSkills() {
  const sel = $('cfg-skill');
  if (!sel) return;
  try {
    state.config = await window.api.getConfig();
    const skills = await window.api.listSkills();
    const current = state.config?.review?.skillId || 'gitlab-mr-review';
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = 'none';
    none.textContent = '不使用技能（通用评审）';
    sel.appendChild(none);
    for (const s of skills) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const label = s.builtin
        ? `${s.id}（内置）`
        : s.id === s.name
          ? s.id
          : `${s.id} · ${s.name}`;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    if (current === 'file' || !skills.some((s) => s.id === current)) {
      sel.value = skills.some((s) => s.id === 'gitlab-mr-review')
        ? 'gitlab-mr-review'
        : 'none';
    } else {
      sel.value = current;
    }
    // force custom dropdown label refresh
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await updateSkillHint(sel.value);
    await renderSkillRoots();
  } catch (e) {
    console.error(e);
  }
}

function shortPath(p) {
  if (!p) return '';
  const home = (window.process && window.process.env && window.process.env.HOME) || '';
  // renderer has no process.env HOME reliably; approximate with ~ replace from known prefix
  let s = String(p);
  // Common mac home prefix
  s = s.replace(/^\/Users\/[^/]+/, '~');
  s = s.replace(/^\/home\/[^/]+/, '~');
  // keep last 2-3 segments if still long
  if (s.length > 48) {
    const parts = s.split('/');
    if (parts.length > 3) {
      return '…/' + parts.slice(-2).join('/');
    }
  }
  return s;
}

async function renderSkillRoots() {
  const dirEl = $('skill-dir-path');
  if (!dirEl) return;
  const dir = state.config?.review?.skillDir || '';
  if (dir) {
    dirEl.hidden = false;
    dirEl.textContent = shortPath(dir);
    dirEl.title = dir;
  } else {
    dirEl.hidden = true;
    dirEl.textContent = '';
    dirEl.title = '';
  }
}

async function updateSkillHint(id) {
  // Static format hint only — no per-skill description dump
  const desc = $('skill-desc');
  if (desc) {
    desc.textContent = '只支持一个额外目录；结构为 <目录>/<skill-id>/SKILL.md。';
  }
  if (id === 'none') return;
  try {
    await window.api.getSkill(id);
  } catch (_) {
    /* ignore */
  }
}

function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.className = `toast ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

async function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${name}`);
  });
  // Unsaved edits should not stick when leaving/re-entering settings
  if (name === 'settings') {
    try {
      state.config = await window.api.getConfig();
      fillSettingsForm();
      const gl = $('gitlab-test-msg');
      const ai = $('ai-test-msg');
      const pj = $('projects-msg');
      if (gl) { gl.textContent = ''; gl.style.color = ''; }
      if (ai) { ai.textContent = ''; ai.style.color = ''; }
      if (pj) { pj.textContent = ''; pj.style.color = ''; }
    } catch (_) {
      /* ignore */
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function loadConfig() {
  state.config = await window.api.getConfig();
  fillSettingsForm();
  updateConnStatus();
  restoreProjectsFromCache();
}

function restoreProjectsFromCache() {
  const c = state.config;
  if (!c) return;
  const cache = c.cache || {};
  const host = c.gitlab?.host || '';
  const token = c.gitlab?.token || '';
  const tokenSig = token.length >= 4 ? `${token.length}:${token.slice(-4)}` : String(token.length);
  if (
    Array.isArray(cache.projects) &&
    cache.projects.length &&
    cache.projectsHost === host &&
    cache.projectsTokenSig === tokenSig
  ) {
    state.projects = cache.projects;
    updateReviewInputPlaceholder();
    const msg = $('projects-msg');
    if (msg) {
      msg.textContent = `已加载 ${cache.projects.length} 个项目`;
      msg.style.color = 'var(--muted)';
    }
  }
}

function fillSettingsForm() {
  const c = state.config;
  if (!c) return;
  $('cfg-gitlab-host').value = c.gitlab?.host || '';
  $('cfg-gitlab-token').value = c.gitlab?.token || '';
  if ($('cfg-gitlab-project')) $('cfg-gitlab-project').value = c.gitlab?.projectPath || '';
  $('cfg-ai-base').value = c.ai?.baseUrl || '';
  $('cfg-ai-key').value = c.ai?.apiKey || '';
  $('cfg-ai-model').value = c.ai?.model || '';

  if ($('cfg-skill') && c.review?.skillId) {
    $('cfg-skill').value = c.review.skillId;
  }
  applyTheme(c.ui?.theme || 'system');
  const srcLabel = `${c.update?.owner || 'HongSphere'}/${c.update?.repo || 'Glint'}`;
  const sidebarSrc = $('sidebar-upd-source');
  if (sidebarSrc) sidebarSrc.textContent = srcLabel;
  const revInput = $('review-project-input');
  if (revInput) {
    revInput.value = c.gitlab?.projectPath || '';
    revInput.title = revInput.value;
    updateClearBtn();
    updateReviewInputPlaceholder();
  }
}

function updateReviewInputPlaceholder() {
  const input = $('review-project-input');
  if (!input) return;
  const g = state.config?.gitlab || {};
  if (!g.host || !g.token) {
    input.placeholder = '请先在「设置」配置 GitLab';
    input.disabled = true;
    return;
  }
  input.disabled = false;
  if (state.projects && state.projects.length) {
    input.placeholder = '请选择需要评审的项目';
  } else {
    input.placeholder = '请点击刷新按钮加载项目';
  }
}

function updateClearBtn() {
  const input = $('review-project-input');
  const clearBtn = $('btn-clear-review-project');
  if (input && clearBtn) {
    clearBtn.hidden = !input.value.trim();
  }
}

function readSettingsForm() {
  return {
    gitlab: {
      host: $('cfg-gitlab-host').value.trim(),
      token: $('cfg-gitlab-token').value.trim(),
      projectPath: $('cfg-gitlab-project')?.value?.trim() || state.config?.gitlab?.projectPath || '',
    },
    ai: {
      baseUrl: $('cfg-ai-base').value.trim(),
      apiKey: $('cfg-ai-key').value.trim(),
      model: $('cfg-ai-model').value.trim(),
    },
    review: {
      skillId: $('cfg-skill')?.value === 'file' ? 'gitlab-mr-review' : ($('cfg-skill')?.value || 'gitlab-mr-review'),
      skillDir: state.config?.review?.skillDir || '',
    },
    ui: {
      theme: state.themePref === 'light' || state.themePref === 'dark' || state.themePref === 'system'
        ? state.themePref
        : 'system',
    },
  };
}

function updateConnStatus() {
  const g = state.config?.gitlab || {};
  const host = g.host || '';
  const project = g.projectPath || '';
  const text =
    host && project
      ? `${host.replace(/^https?:\/\//, '')} · ${project}`
      : host
        ? `${host.replace(/^https?:\/\//, '')} · 请选择项目`
        : '请先在设置中完成 GitLab 与 AI 配置';
  const el = $('conn-status');
  if (el) el.textContent = text;
}

async function saveSettings() {
  try {
    const prevProject = state.config?.gitlab?.projectPath || '';
    state.config = await window.api.setConfig(readSettingsForm());
    fillSettingsForm();
    updateConnStatus();
    await loadSkills();
    const nextProject = state.config?.gitlab?.projectPath || '';
    if (nextProject && nextProject !== prevProject) {
      state.mrsAll = [];
      state.mrs = [];
      state.selectedIid = null;
      state.lastReview = null;
      applyMrFilter();
      syncPostButtonVisibility();
      await loadReviewProjects();
      await refreshMrs();
    }
    toast('设置已保存', 'ok');
  } catch (e) {
    toast(`保存失败: ${e.message}`, 'err');
  }
}

async function refreshMrs() {
  try {
    const g = state.config?.gitlab || {};
    if (!g.host || !g.token || !g.projectPath) {
      state.mrsAll = [];
      state.mrs = [];
      state.selectedIid = null;
      state.lastReview = null;
      applyMrFilter();
      syncPostButtonVisibility();
      return;
    }
    // Always open MRs only
    const all = await window.api.listMergeRequests({ state: 'opened', search: '' });
    state.mrsAll = all;
    if (!all.some((m) => m.iid === state.selectedIid)) {
      state.selectedIid = null;
      state.lastReview = null;
    }
    applyMrFilter();
    syncPostButtonVisibility();
    if (all.length) {
      toast(`已加载 ${all.length} 个打开中的 MR`, 'ok');
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function loadReviewProjects(forceRefresh = false) {
  const input = $('review-project-input');
  const loadBtn = $('btn-load-review-projects');
  const g = state.config?.gitlab || {};
  if (!g.host || !g.token) {
    if (input) {
      input.value = '';
      input.disabled = true;
      input.title = '请先在「设置」配置 GitLab';
    }
    updateReviewInputPlaceholder();
    return;
  }

  if (input) {
    input.disabled = false;
  }
  updateReviewInputPlaceholder();

  if (!forceRefresh && state.projects && state.projects.length) {
    if (input && !input.value && g.projectPath) {
      input.value = g.projectPath;
      input.title = g.projectPath;
      updateClearBtn();
    }
    return;
  }

  if (loadBtn) loadBtn.classList.add('loading');
  try {
    const projects = await window.api.listProjects({
      perPage: 100,
      gitlab: { host: g.host, token: g.token, projectPath: g.projectPath || '' },
    });
    state.projects = projects;
    const cur = g.projectPath || '';
    if (input) {
      if (cur) {
        input.value = cur;
      } else {
        input.value = '';
      }
      input.title = input.value;
      updateClearBtn();
      updateReviewInputPlaceholder();
    }
    if (forceRefresh) {
      toast(`已加载 ${projects.length} 个项目`, 'ok');
    }
  } catch (e) {
    toast(`加载项目失败: ${e.message}`, 'err');
  } finally {
    if (loadBtn) loadBtn.classList.remove('loading');
  }
}

async function selectReviewProject(path) {
  path = (path || '').trim();
  const input = $('review-project-input');
  if (input) {
    input.value = path;
    input.title = path;
  }
  updateClearBtn();
  updateReviewInputPlaceholder();
  closeReviewProjectMenu();
  const g = state.config?.gitlab || {};
  if (path === (g.projectPath || '')) return;
  try {
    state.config = await window.api.setConfig({
      gitlab: {
        host: g.host || '',
        token: g.token || '',
        projectPath: path,
      },
    });
    updateConnStatus();
    state.mrsAll = [];
    state.mrs = [];
    state.selectedIid = null;
    state.lastReview = null;
    applyMrFilter();
    syncPostButtonVisibility();
    if (path) {
      toast(`已切换项目：${path}`, 'ok');
      await refreshMrs();
    } else {
      toast('已清空选定项目', 'info');
      renderMrList();
    }
  } catch (e) {
    toast(`切换项目失败: ${e.message}`, 'err');
  }
}

function filterProjects(q) {
  const list = state.projects || [];
  const query = (q || '').trim().toLowerCase();
  if (!query) return list.slice(0, 50);
  return list
    .filter((p) => p.path.toLowerCase().includes(query) || (p.name || '').toLowerCase().includes(query))
    .slice(0, 50);
}

function closeReviewProjectMenu() {
  const menu = $('review-project-list');
  const input = $('review-project-input');
  if (menu) menu.hidden = true;
  if (input) input.setAttribute('aria-expanded', 'false');
}

function renderReviewProjectMenu(query) {
  const menu = $('review-project-list');
  const input = $('review-project-input');
  if (!menu || !input) return;

  const items = filterProjects(query);
  if (!items.length) {
    menu.innerHTML = '<div class="combo-empty">无匹配项目（可直接输入 group/project 按回车）</div>';
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    return;
  }

  menu.innerHTML = items
    .map((p) => {
      const label = p.archived ? `${p.path} · 归档` : p.path;
      return `<button type="button" class="combo-option" data-path="${escapeHtml(p.path)}" role="option">
        <span class="combo-label">${escapeHtml(label)}</span>
      </button>`;
    })
    .join('');

  menu.hidden = false;
  input.setAttribute('aria-expanded', 'true');

  menu.querySelectorAll('.combo-option').forEach((btn) => {
    btn.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.projectComboLocked = true;
      const path = btn.getAttribute('data-path');
      if (path) {
        input.value = path;
        await selectReviewProject(path);
      }
      closeReviewProjectMenu();
      setTimeout(() => {
        state.projectComboLocked = false;
      }, 150);
    });
  });
}

function bindReviewProjectCombo() {
  const input = $('review-project-input');
  const btn = $('btn-load-review-projects');
  const clearBtn = $('btn-clear-review-project');
  if (!input) return;

  updateClearBtn();

  input.addEventListener('focus', () => {
    if (state.projectComboLocked) return;
    if (state.projects && state.projects.length) {
      renderReviewProjectMenu(input.value);
    }
  });

  input.addEventListener('input', () => {
    updateClearBtn();
    if (state.projectComboLocked) return;
    if (state.projects && state.projects.length) {
      renderReviewProjectMenu(input.value);
    }
  });

  let blurTimer = null;

  if (clearBtn) {
    clearBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    clearBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(blurTimer);
      input.value = '';
      updateClearBtn();
      closeReviewProjectMenu();
      await selectReviewProject('');
      input.blur();
    });
  }

  input.addEventListener('blur', () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (!state.projectComboLocked) closeReviewProjectMenu();
    }, 150);
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      closeReviewProjectMenu();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim();
      await selectReviewProject(val);
      closeReviewProjectMenu();
      input.blur();
    }
  });

  document.addEventListener('mousedown', (e) => {
    const combo = $('review-project-combo') || $('review-project-row');
    if (!combo) return;
    if (!combo.contains(e.target)) {
      closeReviewProjectMenu();
    }
  });

  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        await loadReviewProjects(true);
        input.focus();
        renderReviewProjectMenu(input.value || '');
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    });
  }
}

function applyMrFilter() {
  const q = ($('mr-search')?.value || '').trim().toLowerCase();
  const all = state.mrsAll || [];
  if (!q) {
    state.mrs = all;
  } else {
    state.mrs = all.filter((mr) => {
      const hay = [mr.title || '', mr.sourceBranch || '', mr.targetBranch || '']
        .join('\n')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  renderMrList();
}

let mrSearchTimer = null;
function onMrSearchInput() {
  clearTimeout(mrSearchTimer);
  mrSearchTimer = setTimeout(() => applyMrFilter(), 120);
}

function renderMrList() {
  const box = $('mr-list');
  const count = $('mr-count');
  if (count) count.textContent = state.mrs.length ? `${state.mrs.length} 个` : '';
  if (!state.mrs.length) {
    box.innerHTML = `
      <div class="empty">
        <div class="empty-title">没有匹配的 MR</div>
        <div class="empty-desc">换个关键词，或改状态筛选后点「刷新列表」。</div>
      </div>`;
    return;
  }
  box.innerHTML = state.mrs
    .map((mr) => {
      const active = mr.iid === state.selectedIid ? 'active' : '';
      const draft = mr.draft ? '<span class="badge draft">draft</span>' : '';
      return `<button class="mr-item ${active}" data-iid="${mr.iid}" type="button">
        <div class="t">!${mr.iid} ${escapeHtml(mr.title)}</div>
        <div class="m">
          ${draft}
          <span class="branch">${escapeHtml(mr.sourceBranch)} → ${escapeHtml(mr.targetBranch)}</span>
          <span>${escapeHtml(mr.author)}</span>
        </div>
      </button>`;
    })
    .join('');
  box.querySelectorAll('.mr-item').forEach((el) => {
    el.addEventListener('click', () => selectMr(Number(el.dataset.iid)));
  });
}

function selectMr(iid) {
  state.selectedIid = iid;
  state.lastReview = null;
  document.querySelectorAll('.mr-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.iid) === iid);
  });
  $('result-meta').textContent = `已选中 MR !${iid}`;
  const body = $('result-body');
  if (body) {
    body.innerHTML = `
      <div class="empty tall">
        <div class="empty-title">已选中 MR !${iid}</div>
        <div class="empty-desc">点「开始评审」生成结果；完成后才能写回仓库。</div>
      </div>`;
  }
  const runBtn = $('btn-run');
  if (runBtn) runBtn.textContent = '开始评审';
  syncPostButtonVisibility();
}

function getSelectedMrMeta() {
  return (state.mrsAll || state.mrs || []).find((m) => m.iid === state.selectedIid) || null;
}

function setProgress(show, text) {
  $('progress').hidden = !show;
  if (text) $('progress-text').textContent = text;
}

function renderReview(result) {
  state.lastReview = result;
  const body = $('result-body');

  if (result.empty) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty-title">这个 MR 没有可评审内容</div>
        <div class="empty-desc">${escapeHtml(result.message || '可能是空变更或全是跳过文件。')}</div>
      </div>`;
    return;
  }

  const r = result.review;
  const issues = r.issues || [];
  const positives = r.positives || [];
  const issueHtml = issues.length
    ? `<div class="issue-list">${issues
        .map((iss) => {
          const sev = (iss.severity || 'medium').toLowerCase();
          const loc = iss.file ? `${iss.file}${iss.line ? ':' + iss.line : ''}` : '';
          return `<article class="issue">
            <div class="issue-head">
              <span class="sev ${escapeHtml(sev)}">${escapeHtml(sev)}</span>
              <span class="issue-title">${escapeHtml(iss.title || 'Issue')}</span>
              <span class="loc">${escapeHtml(loc)}</span>
            </div>
            <div class="issue-body">${escapeHtml(iss.body || '')}</div>
          </article>`;
        })
        .join('')}</div>`
    : `
      <div class="empty">
        <div class="empty-title">未发现需要关注的问题</div>
        <div class="empty-desc">可点下方「写回仓库」，或勾选「评审后自动写回」再跑一次。</div>
      </div>`;

  const posHtml = positives.length
    ? `<ul class="positives">${positives.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
    : '';

  body.innerHTML = `
    <div class="review-summary">
      <h2>
        AI 评审
        <span class="verdict ${escapeHtml(r.verdict)}">${escapeHtml(r.verdict)}</span>
      </h2>
      <div class="score-line">评分 ${escapeHtml(r.score)}/10 · 问题 ${issues.length}</div>
      <p>${escapeHtml(r.summary || '')}</p>
      ${posHtml}
      ${issueHtml}
    </div>
  `;

  $('result-meta').textContent = `MR !${result.mr.iid} · ${result.mr.sourceBranch} → ${result.mr.targetBranch}`;
  const runBtn = $('btn-run');
  if (runBtn) runBtn.textContent = '重新评审';
  syncPostButtonVisibility();
}

function clearReviewResult(message) {
  state.lastReview = null;
  syncPostButtonVisibility();
  const body = $('result-body');
  if (body) {
    body.innerHTML = `
      <div class="empty tall">
        <div class="empty-title">${escapeHtml(message)}</div>
        <div class="empty-desc">本次评审已丢弃，不会写回仓库。可重新点「开始评审」。</div>
      </div>`;
  }
  if ($('result-meta')) $('result-meta').textContent = '已停止';
  const runBtn = $('btn-run');
  if (runBtn) runBtn.textContent = '开始评审';
}

async function runReview() {
  const iid = state.selectedIid;
  if (!iid) {
    toast('请先选择 MR', 'err');
    return;
  }
  const meta = getSelectedMrMeta();
  if (meta && meta.state && meta.state !== 'opened') {
    toast(`仅支持评审打开中的 MR（!${iid} 当前: ${meta.state}）`, 'err');
    return;
  }
  const runBtn = $('btn-run');
  const stopBtn = $('btn-stop');
  state.reviewing = true;
  runBtn.disabled = true;
  if (stopBtn) stopBtn.hidden = false;
  syncPostButtonVisibility();
  setProgress(true, '准备中…');
  try {
    const result = await window.api.runReview({ iid, includeRaw: false });
    setProgress(false);
    if (result.empty) {
      renderReview(result);
      return;
    }
    result.filesCount = result.review?.issues?.length ?? 0;
    renderReview(result);
    if ($('chk-auto-post')?.checked) {
      toast('评审完成，正在自动写回…', 'ok');
      await postReview({ silent: true });
    } else {
      toast('评审完成，可写回仓库或重新评审', 'ok');
    }
  } catch (e) {
    setProgress(false);
    const msg = String(e.message || '');
    if (msg.includes('取消') || msg.includes('aborted') || msg.includes('已取消')) {
      toast('已停止并放弃本次评审', 'ok');
      clearReviewResult('评审已停止');
    } else {
      toast(e.message, 'err');
    }
  } finally {
    state.reviewing = false;
    if (stopBtn) stopBtn.hidden = true;
    syncPostButtonVisibility();
  }
}

function syncRunButtonState() {
  const runBtn = $('btn-run');
  if (!runBtn) return;
  const hasSelectedMr = Boolean(state.selectedIid);
  runBtn.disabled = state.reviewing || !hasSelectedMr;
}

function syncPostButtonVisibility() {
  const btn = $('btn-post');
  if (btn) {
    const auto = $('chk-auto-post')?.checked;
    const hasResult = Boolean(state.lastReview && state.lastReview.review);
    // hide while reviewing/re-reviewing, when auto-post is on, or before a result exists
    btn.hidden = state.reviewing || Boolean(auto) || !hasResult;
  }
  syncRunButtonState();
}

async function postReview(opts = {}) {
  if (!state.lastReview || !state.lastReview.review) {
    toast('没有可写回的评审结果', 'err');
    return;
  }
  const noInline = $('chk-no-inline').checked;
  $('btn-post').disabled = true;
  $('btn-run').disabled = true;
  try {
    const res = await window.api.postReview({
      iid: state.lastReview.mr.iid,
      review: state.lastReview.review,
      skipInline: noInline,
    });
    if (!opts.silent) {
      toast(`已写回仓库：总结${res.summaryAction === 'updated' ? '已更新' : '已创建'}，行内 ${res.inlineCount} 条`, 'ok');
    } else {
      toast(`已自动写回：总结${res.summaryAction === 'updated' ? '已更新' : '已创建'}，行内 ${res.inlineCount} 条`, 'ok');
    }
  } catch (e) {
    toast(`写回失败: ${formatError(e)}`, 'err');
  } finally {
    $('btn-post').disabled = false;
    syncPostButtonVisibility();
  }
}

async function persistFormBeforeTest() {
  return readSettingsForm();
}

async function testGitLab() {
  const btn = $('btn-test-gitlab');
  const el = $('gitlab-test-msg');
  if (btn) btn.disabled = true;
  el.textContent = '测试中…';
  el.style.color = 'var(--muted)';
  try {
    const form = readSettingsForm();
    if (!form.gitlab.host || !form.gitlab.token) {
      el.textContent = '请先填写主机地址与 Token';
      el.style.color = 'var(--danger)';
      return;
    }
    const res = await window.api.testGitLab(form.gitlab);
    el.textContent = res.message;
    el.title = res.message || '';
    el.style.color = res.ok ? 'var(--ok)' : 'var(--danger)';
  } catch (e) {
    el.textContent = e.message;
    el.title = e.message || '';
    el.style.color = 'var(--danger)';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function testAI() {
  const btn = $('btn-test-ai');
  const el = $('ai-test-msg');
  if (btn) btn.disabled = true;
  el.textContent = '测试中…';
  el.title = '';
  el.style.color = 'var(--muted)';
  try {
    const form = readSettingsForm();
    if (!form.ai.apiKey) {
      el.textContent = '请先填写 AI API Key';
      el.title = '请先填写 AI API Key';
      el.style.color = 'var(--danger)';
      return;
    }
    if (!form.ai.baseUrl || !form.ai.model) {
      el.textContent = '请先填写 Base URL 与模型';
      el.title = '请先填写 Base URL 与模型';
      el.style.color = 'var(--danger)';
      return;
    }
    const res = await window.api.testAI(form.ai);
    el.textContent = res.message;
    el.title = res.message || '';
    el.style.color = res.ok ? 'var(--ok)' : 'var(--danger)';
  } catch (e) {
    el.textContent = e.message;
    el.title = e.message || '';
    el.style.color = 'var(--danger)';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function applyUpdateState(s) {
  if (!s) return;
  const msg = $('update-msg');
  if (!msg) return;
  msg.classList.remove('ok', 'err', 'ready');
  if (s.downloaded) {
    msg.textContent = `有更新 ${s.version || ''} · 点击安装`;
    msg.classList.add('ready');
  } else if (s.error) {
    msg.textContent = s.message || '检查更新失败';
    msg.classList.add('err');
  } else if (s.checking) {
    msg.textContent = '检查中…';
  } else if (s.message === '已是最新版本') {
    msg.textContent = '已是最新版本';
    msg.classList.add('ok');
  } else {
    msg.textContent = s.message || '';
  }
}

async function loadAbout() {
  const info = await window.api.appInfo();
  state.appInfo = info;
  $('app-version').textContent = `v${info.version}`;
  $('about-body').innerHTML = `
    <dl>
      <dt>应用版本</dt><dd>${escapeHtml(info.version)}</dd>
      <dt>运行平台</dt><dd>${escapeHtml(info.platform)}</dd>
      <dt>配置目录</dt><dd><code>${escapeHtml(info.userData)}</code></dd>
      <dt>更新源</dt><dd>GitHub Releases（HongSphere/Glint）</dd>
    </dl>
    <p class="hint-block">
      对 GitLab 打开中的 Merge Request 做 AI 代码评审，可将总结与行内评论写回仓库。
    </p>
  `;
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
    });
  });

  $('btn-save').addEventListener('click', saveSettings);
  $('btn-reset').addEventListener('click', async () => {
    if (!window.confirm('确定恢复默认配置？会清空本机保存的 Token/Key。')) return;
    state.config = await window.api.resetConfig();
    fillSettingsForm();
    updateConnStatus();
    toast('已恢复默认', 'ok');
  });
  $('btn-test-gitlab').addEventListener('click', testGitLab);
  bindReviewProjectCombo();
  $('btn-test-ai').addEventListener('click', testAI);
  $('btn-refresh').addEventListener('click', refreshMrs);
  $('btn-run').addEventListener('click', runReview);
  const stopBtn = $('btn-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        await window.api.stopReview();
        toast('正在停止…', 'ok');
      } finally {
        stopBtn.disabled = false;
      }
    });
  }
  $('btn-post').addEventListener('click', postReview);
  $('chk-auto-post').addEventListener('change', syncPostButtonVisibility);
  $('mr-search').addEventListener('input', onMrSearchInput);
  $('mr-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refreshMrs();
  });
  document.querySelectorAll('input[name="ui-theme"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (el.checked) {
        // preview only; persist + apply after 保存
        state.themePref = el.value === 'light' || el.value === 'dark' || el.value === 'system' ? el.value : 'system';
      }
    });
  });
  mediaDark.addEventListener('change', () => {
    if (state.themePref === 'system') applyTheme('system');
  });
  $('cfg-skill').addEventListener('change', () => updateSkillHint($('cfg-skill').value));
  $('btn-skill-dir').addEventListener('click', async () => {
    const dir = await window.api.setSkillDir();
    if (!dir) return;
    state.config = await window.api.getConfig();
    await loadSkills();
    toast('技能目录已更新', 'ok');
  });
  const clearDir = $('btn-skill-dir-clear');
  if (clearDir) {
    clearDir.addEventListener('click', async () => {
      await window.api.clearSkillDir();
      state.config = await window.api.getConfig();
      await loadSkills();
      toast('已清除自定义目录', 'ok');
    });
  }
  $('update-chip').addEventListener('click', async () => {
    const s = await window.api.updateState();
    if (s?.downloaded) {
      window.api.installUpdate();
      return;
    }
    window.api.checkUpdate(true);
  });

  window.api.onReviewProgress((p) => {
    setProgress(true, p.message || p.step);
  });
  window.api.onUpdateState(applyUpdateState);
}

/* ---------- in-page custom select (avoid broken native popup placement) ---------- */
function enhanceSelect(select) {
  if (!select || select.dataset.enhanced === '1') return;
  select.dataset.enhanced = '1';
  select.classList.add('select-native');

  const wrapper = document.createElement('div');
  wrapper.className = 'cselect';
  const cs = getComputedStyle(select);
  if (select.id === 'cfg-skill') {
    wrapper.style.width = '100%';
    wrapper.style.display = 'block';
    wrapper.style.minWidth = '0';
    wrapper.style.maxWidth = 'none';
  } else if (select.classList.contains('select-narrow')) {
    wrapper.style.width = '124px';
    wrapper.style.minWidth = '124px';
    wrapper.style.maxWidth = '124px';
  } else {
    // full-width selects in form grids
    wrapper.style.width = '100%';
    wrapper.style.display = 'block';
  }
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cselect-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  wrapper.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'cselect-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  wrapper.appendChild(menu);

  const originalValueDesc = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value'
  );

  function optionLabel(opt) {
    return (opt && opt.textContent) || '';
  }

  function refreshButton() {
    const opt = select.options[select.selectedIndex];
    btn.textContent = optionLabel(opt) || '请选择';
    btn.title = btn.textContent;
    Array.from(menu.children).forEach((el) => {
      el.classList.toggle('selected', el.dataset.value === select.value);
      el.setAttribute('aria-selected', el.dataset.value === select.value ? 'true' : 'false');
    });
  }

  function rebuildMenu() {
    menu.innerHTML = '';
    Array.from(select.options).forEach((opt) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'cselect-option';
      item.dataset.value = opt.value;
      item.setAttribute('role', 'option');
      item.textContent = optionLabel(opt);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        originalValueDesc.set.call(select, opt.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        close();
        refreshButton();
      });
      menu.appendChild(item);
    });
    refreshButton();
  }

  function placeMenu() {
    menu.style.width = `${wrapper.offsetWidth}px`;
    const rect = wrapper.getBoundingClientRect();
    const vh = window.innerHeight;
    const menuH = Math.min(menu.scrollHeight || 240, 280);
    const below = rect.bottom + menuH + 8 <= vh;
    menu.classList.toggle('drop-up', !below);
    if (below) {
      menu.style.top = 'calc(100% + 4px)';
      menu.style.bottom = 'auto';
      menu.style.maxHeight = `${Math.max(120, vh - rect.bottom - 16)}px`;
    } else {
      menu.style.bottom = 'calc(100% + 4px)';
      menu.style.top = 'auto';
      menu.style.maxHeight = `${Math.max(120, rect.top - 16)}px`;
    }
  }

  function open() {
    closeAllCSelects(wrapper);
    rebuildMenu();
    placeMenu();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('open');
  }

  function close() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    wrapper.classList.remove('open');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });

  // keep in sync when code sets select.value
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() {
      return originalValueDesc.get.call(this);
    },
    set(v) {
      originalValueDesc.set.call(this, v);
      refreshButton();
    },
  });

  select.addEventListener('change', refreshButton);

  const mo = new MutationObserver(() => rebuildMenu());
  mo.observe(select, { childList: true, subtree: true });

  rebuildMenu();
}

function closeAllCSelects(except) {
  document.querySelectorAll('.cselect.open').forEach((w) => {
    if (w === except) return;
    w.classList.remove('open');
    const m = w.querySelector('.cselect-menu');
    const b = w.querySelector('.cselect-btn');
    if (m) m.hidden = true;
    if (b) b.setAttribute('aria-expanded', 'false');
  });
}

function enhanceAllSelects() {
  document.querySelectorAll('select.input').forEach((el) => {
    if (el.id === 'review-project-select') return; // native select
    enhanceSelect(el);
  });
}

async function init() {
  applyTheme('system');
  bindEvents();
  syncPostButtonVisibility();
  enhanceAllSelects();
  await loadAbout();
  await loadConfig();
  await loadSkills();
  enhanceAllSelects();
  await loadReviewProjects();
  enhanceAllSelects();
  const us = await window.api.updateState();
  applyUpdateState(us);
}

document.addEventListener('click', () => closeAllCSelects());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllCSelects();
});

init().catch((e) => toast(e.message, 'err'));
