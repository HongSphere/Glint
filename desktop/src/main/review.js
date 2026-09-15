'use strict';

const { getAIConfig, getReviewOptions } = require('./config');
const { skillPromptBlock, resolveSkill } = require('./skills');
const {
  request,
  getMergeRequest,
  createNote,
  listDiscussions,
  createDiscussion,
} = require('./gitlab');

const MARKER = '<!-- ai-mr-review -->';

const SKIP_PATH_RE = new RegExp(
  '(' +
    'package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|poetry\\.lock|Cargo\\.lock|' +
    'go\\.sum|composer\\.lock|Gemfile\\.lock|' +
    'dist/|build/|vendor/|node_modules/|\\.min\\.(js|css)|' +
    '\\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|wav)$' +
    ')',
  'i'
);

const SYSTEM_PROMPT = `你是资深代码评审员，负责 GitLab Merge Request 评审。
只基于给出的 diff 与上下文判断，不要臆造文件外事实。

输出必须是严格 JSON（不要 markdown 代码块外的任何文字）：
{
  "summary": "2-5 句总体评价，中文",
  "verdict": "approve | comment | request_changes",
  "score": 0-10,
  "positives": ["做得好的点"],
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "相对路径",
      "line": 123,
      "side": "new|old",
      "title": "一句话标题",
      "body": "问题说明 + 可执行修改建议，中文"
    }
  ]
}

约束：
- 如实报告发现的问题，不要遗漏重要问题；纯风格吹毛求疵可忽略
- line 必须是 diff 中实际出现的行号；不确定就放进 summary，不要乱挂行
- side: 表示新增行用 new，删除/旧文件行用 old
- 没有问题就返回空 issues，verdict=approve
- 不要输出无关闲聊
`;

function buildSystemPrompt(limits = {}) {
  const opts = {
    skillId: limits.skillId || 'gitlab-mr-review',
    skillDir: limits.skillDir || '',
  };
  const sk = resolveSkill(opts);
  const block = skillPromptBlock(opts);
  let prompt = SYSTEM_PROMPT;
  if (block) {
    const skillName = `${sk.id} (${sk.name})`;
    prompt = `${prompt}\n当前技能：${skillName}\n\n${block}\n`;
  } else {
    prompt = `${prompt}\n当前技能：未加载（使用通用评审默认）\n`;
  }
  return prompt;
}

function filterChanges(changes) {
  const kept = [];
  for (const ch of changes || []) {
    const path = ch.new_path || ch.old_path || '';
    if (!path || SKIP_PATH_RE.test(path)) continue;
    if (!(ch.diff || '').trim()) continue;
    kept.push(ch);
  }
  return kept;
}

function buildDiffPayload(mr) {
  const parts = [];
  const used = [];
  const filtered = filterChanges(mr.changes);
  for (const ch of filtered) {
    const path = ch.new_path || ch.old_path;
    const diff = ch.diff || '';
    parts.push(`### FILE: ${path}\n${diff}\n`);
    used.push(ch);
  }
  return { text: parts.join(''), used };
}

function parseReviewJson(text) {
  let t = (text || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const data = JSON.parse(t);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('AI 输出不是 JSON 对象');
  }
  return {
    summary: data.summary || '',
    verdict: data.verdict || 'comment',
    score: data.score == null ? 5 : data.score,
    positives: Array.isArray(data.positives) ? data.positives : [],
    issues: Array.isArray(data.issues) ? data.issues : [],
  };
}

async function chatComplete(system, user) {
  const ai = getAIConfig();
  if (!ai.apiKey) throw new Error('请先在设置里填写 AI API Key');
  const url = `${ai.baseUrl}/chat/completions`;
  const signal = currentAbort ? currentAbort.signal : undefined;
  const res = await request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ai.apiKey}` },
    body: {
      model: ai.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    timeout: 0,
    signal,
  });
  if (!res.ok) {
    const msg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
    throw new Error(`AI API 调用失败 ${res.status}: ${msg}`);
  }
  const content = res.json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 响应结构异常');
  return content;
}

let currentAbort = null;

function stopReview() {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
    return { ok: true, message: '已发送停止请求' };
  }
  return { ok: false, message: '当前没有进行中的评审' };
}

async function testAI() {
  const ai = getAIConfig();
  if (!ai.apiKey) return { ok: false, message: '未保存 AI API Key（设置里填完请点测试或保存）' };
  if (!ai.baseUrl) return { ok: false, message: '未配置 AI Base URL' };
  if (!ai.model) return { ok: false, message: '未配置模型名' };
  try {
    const raw = await chatComplete(
      '你是连通性测试助手。只输出 JSON：{"ok":true,"pong":true}',
      '请回复 pong'
    );
    return { ok: true, message: `模型可调用: ${ai.model}`, raw: raw.slice(0, 200) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function validLine(diff, side, line) {
  if (!line || line <= 0) return false;
  let oldLn = 0;
  let newLn = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!m) return false;
      oldLn = parseInt(m[1], 10);
      newLn = parseInt(m[2], 10);
      continue;
    }
    if (raw.startsWith('+')) {
      if (side === 'new' && newLn === line) return true;
      newLn += 1;
    } else if (raw.startsWith('-')) {
      if (side === 'old' && oldLn === line) return true;
      oldLn += 1;
    } else if (raw.startsWith('\\')) {
      continue;
    } else {
      if (side === 'new' && newLn === line) return true;
      if (side === 'old' && oldLn === line) return true;
      oldLn += 1;
      newLn += 1;
    }
  }
  return false;
}

function buildUserPrompt(mr, diffText) {
  return `请评审以下 Merge Request。

## MR 元信息
- 标题: ${mr.title}
- 分支: ${mr.sourceBranch} → ${mr.targetBranch}
- 链接: ${mr.webUrl}

## MR 描述
${mr.description || '（空）'}

## Diff
${diffText}

请输出严格 JSON。
`;
}

async function runReview(opts = {}, onProgress = () => {}) {
  const limits = { ...getReviewOptions(), ...(opts.limits || {}) };
  const iid = Number(opts.iid);
  if (!Number.isFinite(iid) || iid <= 0) throw new Error('请选择要评审的 MR');

  onProgress({ step: 'fetch', message: `拉取 MR !${iid} …` });
  const mr = await getMergeRequest(iid);
  if (mr.state && mr.state !== 'opened') {
    throw new Error(`仅支持评审打开中的 MR（当前状态: ${mr.state}）`);
  }
  onProgress({
    step: 'diff',
    message: `变更文件 ${mr.changes.length} 个`,
    mr: {
      iid: mr.iid,
      title: mr.title,
      webUrl: mr.webUrl,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
    },
  });

  const { text, used } = buildDiffPayload(mr);
  if (!text.trim()) {
    return {
      ok: true,
      empty: true,
      message: '无可评审 diff（可能全是跳过文件）',
      mr,
      review: null,
    };
  }

  onProgress({
    step: 'ai',
    message: `调用模型评审 ${used.length} 个文件（约 ${Math.round(text.length / 1024)} KB diff）…`,
    files: used.map((c) => c.new_path || c.old_path),
  });

  currentAbort = new AbortController();
  let raw;
  try {
    const system = buildSystemPrompt(limits);
    raw = await chatComplete(system, buildUserPrompt(mr, text));
  } finally {
    currentAbort = null;
  }
  let review;
  try {
    review = parseReviewJson(raw);
  } catch (e) {
    throw new Error(`AI 输出无法解析为 JSON: ${e.message}`);
  }

  onProgress({ step: 'done', message: '评审完成' });
  return {
    ok: true,
    empty: false,
    mr,
    review,
    limits,
    // keep raw for debugging in dry-run
    raw: opts.includeRaw ? raw : undefined,
  };
}

function renderSummaryMarkdown(review) {
  const positives = review.positives || [];
  const issues = review.issues || [];
  const lines = [
    MARKER,
    `## AI Code Review · ${review.verdict} · ${review.score}/10`,
    '',
    review.summary || '（无总体评价）',
    '',
  ];
  if (positives.length) {
    lines.push('**亮点**');
    for (const p of positives.slice(0, 8)) lines.push(`- ${p}`);
    lines.push('');
  }
  if (issues.length) {
    lines.push('**问题摘要**');
    issues.slice(0, 30).forEach((iss, i) => {
      const loc = iss.file || '';
      const loc2 = iss.line ? `${loc}:${iss.line}` : loc;
      lines.push(`${i + 1}. [${iss.severity || 'medium'}] ${iss.title || 'issue'} — \`${loc2}\``);
    });
    lines.push('');
    lines.push('详细见行内评论（若有）。');
  } else {
    lines.push('未发现需要阻塞合并的问题。');
  }
  return lines.join('\n');
}

async function postReviewToGitLab({ iid, review, skipInline = false, limit = 15 }) {
  const n = Number(iid);
  if (!Number.isFinite(n)) throw new Error('缺少 MR 编号');
  if (!review) throw new Error('缺少评审结果');

  const mr = await getMergeRequest(n);
  if (mr.state && mr.state !== 'opened') {
    throw new Error(`仅支持写回打开中的 MR（当前状态: ${mr.state}）`);
  }
  const body = renderSummaryMarkdown(review);

  // update existing marker note if any
  let updated = false;
  try {
    const discussions = await listDiscussions(n);
    for (const d of discussions || []) {
      for (const note of d.notes || []) {
        if ((note.body || '').includes(MARKER)) {
          // create a new summary note anyway if PUT is awkward; prefer replace via notes API
          // GitLab: PUT /projects/:id/merge_requests/:iid/notes/:note_id
          const { api, encodeProject } = require('./gitlab');
          const { getGitLabConfig } = require('./config');
          const cfg = getGitLabConfig();
          await api(
            `/projects/${encodeProject(cfg.projectPath)}/merge_requests/${n}/notes/${note.id}`,
            { method: 'PUT', body: { body } }
          );
          updated = true;
          break;
        }
      }
      if (updated) break;
    }
  } catch (_) {
    // fall through to create
  }
  if (!updated) {
    await createNote(n, body);
  }

  let inlineCount = 0;
  if (!skipInline && mr.baseSha && mr.headSha && mr.startSha) {
    const changesByPath = {};
    for (const c of mr.changes || []) {
      changesByPath[c.new_path || c.old_path] = c;
    }
    for (const iss of review.issues || []) {
      if (inlineCount >= limit) break;
      const path = iss.file;
      if (!path || !changesByPath[path]) continue;
      let side = (iss.side || 'new').toLowerCase();
      if (side !== 'new' && side !== 'old') side = 'new';
      const line = Number(iss.line);
      const diff = changesByPath[path].diff || '';
      if (!validLine(diff, side, line)) continue;

      const position = {
        position_type: 'text',
        base_sha: mr.baseSha,
        head_sha: mr.headSha,
        start_sha: mr.startSha,
      };
      if (side === 'new') {
        position.new_path = path;
        position.new_line = line;
        if (changesByPath[path].renamed_file) {
          position.old_path = changesByPath[path].old_path || path;
        }
      } else {
        position.old_path = path;
        position.old_line = line;
        position.new_path = changesByPath[path].new_path || path;
      }

      try {
        await createDiscussion(n, {
          body: `**[${iss.severity || 'medium'}] ${iss.title || 'Issue'}**\n\n${iss.body || ''}`,
          position,
        });
        inlineCount += 1;
      } catch (e) {
        // skip failed inline
      }
    }
  }

  return {
    ok: true,
    summaryAction: updated ? 'updated' : 'created',
    inlineCount,
    webUrl: mr.webUrl,
  };
}

module.exports = {
  MARKER,
  SKIP_PATH_RE,
  buildSystemPrompt,
  filterChanges,
  buildDiffPayload,
  parseReviewJson,
  validLine,
  testAI,
  runReview,
  stopReview,
  postReviewToGitLab,
  renderSummaryMarkdown,
};
