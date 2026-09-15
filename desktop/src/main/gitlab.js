'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getGitLabConfig } = require('./config');

function request(urlString, { method = 'GET', headers = {}, body = null, timeout = 30000, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error(`无效 URL: ${urlString}`));
      return;
    }
    const lib = url.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
            json = null;
          }
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text,
            json,
            headers: res.headers,
          });
        });
      }
    );
    if (timeout && timeout > 0) {
      req.setTimeout(timeout, () => {
        req.destroy(new Error('请求超时'));
      });
    }
    const onAbort = () => {
      req.destroy(new Error('请求已取消'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch (_) {
          /* ignore */
        }
      });
    }
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * POST JSON and read SSE or plain JSON response.
 * Resolves { status, ok, text, contentType }.
 */
function requestStream(urlString, { method = 'POST', headers = {}, body = null, timeout = 0, signal = null, onDelta = null } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error(`无效 URL: ${urlString}`));
      return;
    }
    const lib = url.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    let settled = false;
    let full = '';
    let rawAll = '';
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers: {
          Accept: 'text/event-stream, application/json',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const contentType = String(res.headers['content-type'] || '');
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const err = new Error(`AI API 调用失败 ${res.statusCode}: ${text.slice(0, 400)}`);
            err.status = res.statusCode;
            err.text = text;
            finish(reject, err);
          });
          return;
        }

        // Non-SSE JSON (provider ignored stream=true)
        if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              const obj = JSON.parse(text);
              const content =
                obj?.choices?.[0]?.message?.content ??
                obj?.choices?.[0]?.delta?.content ??
                '';
              if (typeof onDelta === 'function' && content) onDelta(content);
              finish(resolve, { status: res.statusCode, ok: true, text: content, contentType });
            } catch (_) {
              finish(resolve, { status: res.statusCode, ok: true, text, contentType });
            }
          });
          res.on('error', (err) => finish(reject, err));
          return;
        }

        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          rawAll += chunk;
          buf += chunk;
          // handle both \n and \r\n
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? '';
          for (let raw of parts) {
            let data = raw.trim();
            if (!data) continue;
            if (data.startsWith('data:')) data = data.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const obj = JSON.parse(data);
              const delta =
                obj?.choices?.[0]?.delta?.content ??
                obj?.choices?.[0]?.message?.content ??
                '';
              if (delta) {
                full += delta;
                if (typeof onDelta === 'function') onDelta(delta);
              }
            } catch (_) {
              /* ignore */
            }
          }
        });
        res.on('end', () => {
          // last leftover line
          if (buf.trim()) {
            let data = buf.trim();
            if (data.startsWith('data:')) data = data.slice(5).trim();
            if (data && data !== '[DONE]') {
              try {
                const obj = JSON.parse(data);
                const delta =
                  obj?.choices?.[0]?.delta?.content ??
                  obj?.choices?.[0]?.message?.content ??
                  '';
                if (delta) {
                  full += delta;
                  if (typeof onDelta === 'function') onDelta(delta);
                }
              } catch (_) {
                /* ignore */
              }
            }
          }
          // If stream produced nothing but raw looks like full JSON message
          if (!full && rawAll.includes('"choices"')) {
            try {
              const obj = JSON.parse(rawAll.replace(/^data:\s*/m, ''));
              const content =
                obj?.choices?.[0]?.message?.content ??
                obj?.choices?.[0]?.delta?.content ??
                '';
              if (content) full = content;
            } catch (_) {
              /* ignore */
            }
          }
          finish(resolve, { status: res.statusCode, ok: true, text: full, contentType });
        });
        res.on('error', (err) => finish(reject, err));
      }
    );
    if (timeout && timeout > 0) {
      req.setTimeout(timeout, () => {
        req.destroy(new Error('请求超时'));
      });
    }
    const onAbort = () => {
      req.destroy(new Error('请求已取消'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch (_) {
          /* ignore */
        }
      });
    }
    req.on('error', (err) => finish(reject, err));
    if (payload) req.write(payload);
    req.end();
  });
}

function encodeProject(projectPath) {
  return encodeURIComponent(projectPath);
}

function requireGitLab({ needProject = true } = {}) {
  const cfg = getGitLabConfig();
  if (!cfg.host) throw new Error('请先在设置里填写 GitLab 地址');
  if (!cfg.token) throw new Error('请先在设置里填写 GitLab Token（api scope）');
  if (needProject && !cfg.projectPath) {
    throw new Error('请先在设置里填写项目路径，如 group/repo');
  }
  return cfg;
}

async function api(path, options = {}) {
  const cfg = requireGitLab();
  const base = `https://${cfg.host}/api/v4`;
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await request(url, {
    method: options.method || 'GET',
    headers: {
      'PRIVATE-TOKEN': cfg.token,
      ...(options.headers || {}),
    },
    body: options.body,
    timeout: options.timeout,
  });
  if (!res.ok) {
    const msg = res.json?.message || res.json?.error || res.text || `HTTP ${res.status}`;
    const err = new Error(`GitLab API 失败 ${res.status}: ${msg}`);
    err.status = res.status;
    err.payload = res.json;
    throw err;
  }
  return res.json;
}

/** Projects the token can access (membership). */
async function listProjects({ search = '', simple = true, perPage = 50 } = {}) {
  const cfg = requireGitLab({ needProject: false });
  const base = `https://${cfg.host}/api/v4`;
  const params = new URLSearchParams({
    membership: 'true',
    order_by: 'last_activity_at',
    sort: 'desc',
    per_page: String(perPage),
  });
  if (search) params.set('search', search);
  if (simple) params.set('simple', 'true');
  const res = await request(`${base}/projects?${params.toString()}`, {
    headers: { 'PRIVATE-TOKEN': cfg.token },
  });
  if (!res.ok) {
    const msg = res.json?.message || res.json?.error || res.text || `HTTP ${res.status}`;
    throw new Error(`GitLab API 失败 ${res.status}: ${msg}`);
  }
  const list = res.json;
  return (list || []).map((p) => ({
    id: p.id,
    path: p.path_with_namespace,
    name: p.name,
    namespace: p.namespace?.full_path || p.path_with_namespace?.split('/').slice(0, -1).join('/') || '',
    lastActivityAt: p.last_activity_at,
    archived: Boolean(p.archived),
  }));
}

async function testGitLab() {
  const cfg = getGitLabConfig();
  if (!cfg.host) return { ok: false, message: '未配置 GitLab 地址' };
  if (!cfg.token) return { ok: false, message: '未配置 GitLab Token' };
  try {
    const user = await api('/user');
    let project = null;
    if (cfg.projectPath) {
      project = await api(`/projects/${encodeProject(cfg.projectPath)}`);
    }
    return {
      ok: true,
      message: project
        ? `已连接 ${user.username || user.name} · ${project.path_with_namespace}`
        : `已连接 ${user.username || user.name}（未填项目路径）`,
      user: { username: user.username, name: user.name },
      project: project
        ? { id: project.id, path: project.path_with_namespace, web_url: project.web_url }
        : null,
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function listMergeRequests({ state = 'opened', search = '' } = {}) {
  const cfg = requireGitLab();
  const params = new URLSearchParams({
    state,
    per_page: '50',
    order_by: 'updated_at',
    sort: 'desc',
  });
  if (search) params.set('search', search);
  const list = await api(
    `/projects/${encodeProject(cfg.projectPath)}/merge_requests?${params.toString()}`
  );
  return (list || []).map((mr) => ({
    iid: mr.iid,
    title: mr.title,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    state: mr.state,
    author: mr.author?.username || mr.author?.name || '',
    updatedAt: mr.updated_at,
    webUrl: mr.web_url,
    draft: Boolean(mr.draft || mr.work_in_progress),
  }));
}

async function getMergeRequest(iid) {
  const cfg = requireGitLab();
  const n = Number(iid);
  if (!Number.isFinite(n) || n <= 0) throw new Error('无效的 MR 编号');
  const mr = await api(`/projects/${encodeProject(cfg.projectPath)}/merge_requests/${n}`);
  const changes = await api(
    `/projects/${encodeProject(cfg.projectPath)}/merge_requests/${n}/changes`
  );
  const diffRefs = mr.diff_refs || changes.diff_refs || {};
  return {
    iid: mr.iid,
    projectId: mr.project_id,
    title: mr.title,
    description: (mr.description || '').slice(0, 2000),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    webUrl: mr.web_url,
    state: mr.state,
    baseSha: diffRefs.base_sha || '',
    headSha: diffRefs.head_sha || '',
    startSha: diffRefs.start_sha || '',
    changes: changes.changes || [],
  };
}

async function createNote(iid, body) {
  const cfg = requireGitLab();
  return api(`/projects/${encodeProject(cfg.projectPath)}/merge_requests/${Number(iid)}/notes`, {
    method: 'POST',
    body: { body },
  });
}

async function listDiscussions(iid, perPage = 100) {
  const cfg = requireGitLab();
  return api(
    `/projects/${encodeProject(cfg.projectPath)}/merge_requests/${Number(iid)}/discussions?per_page=${perPage}`
  );
}

async function createDiscussion(iid, payload) {
  const cfg = requireGitLab();
  return api(
    `/projects/${encodeProject(cfg.projectPath)}/merge_requests/${Number(iid)}/discussions`,
    {
      method: 'POST',
      body: payload,
    }
  );
}

module.exports = {
  request,
  requestStream,
  api,
  testGitLab,
  listProjects,
  listMergeRequests,
  getMergeRequest,
  createNote,
  listDiscussions,
  createDiscussion,
  encodeProject,
};
