'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_SKILL_BODY = parseInt(process.env.GLINT_SKILL_MAX_CHARS || '12000', 10);

function builtinSkillsDir() {
  // packaged: resources/assets/skills; dev: <repo>/assets/skills
  const dev = path.join(app.getAppPath(), 'assets', 'skills');
  if (fs.existsSync(dev)) return dev;
  const res =
    process.resourcesPath && path.join(process.resourcesPath, 'assets', 'skills');
  if (res && fs.existsSync(res)) return res;
  return dev;
}

function expandHome(p) {
  if (!p) return '';
  if (p.startsWith('~/') || p === '~') {
    return require('os').homedir() + p.slice(1);
  }
  return p;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text };
  const fm = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, '');
  const meta = {};
  for (const line of fm.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    meta[m[1].toLowerCase()] = v;
  }
  return { meta, body };
}

function loadSkillFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const id = meta.name || path.basename(path.dirname(filePath));
  const description = meta.description || '';
  const firstHeading = body.split('\n').find((l) => l.startsWith('# '));
  const title = firstHeading ? firstHeading.replace(/^#\s+/, '').trim() : id;
  return {
    id,
    name: title,
    description,
    path: filePath,
    dir: path.dirname(filePath),
    body: body.trim(),
    builtin: false,
  };
}

function collectSkillFiles(root, depth = 2) {
  const found = [];
  function walk(dir, left) {
    if (left < 0) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === 'SKILL.md') {
        found.push(full);
        continue;
      }
      if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
        walk(full, left - 1);
      }
    }
  }
  walk(root, depth);
  return found;
}

/**
 * Skills = built-in gitlab-mr-review + only user-selected directories.
 * No auto-scan of ~/.claude / ~/.config/mimocode / etc.
 */
function asDirList(skillDirs) {
  if (!skillDirs) return [];
  if (Array.isArray(skillDirs)) return skillDirs.filter(Boolean);
  return [skillDirs];
}

function listSkills(skillDirs = []) {
  const byId = new Map();

  // 1) built-in
  const bRoot = builtinSkillsDir();
  if (isDir(bRoot)) {
    for (const skillMd of collectSkillFiles(bRoot, 2)) {
      try {
        const sk = loadSkillFile(skillMd);
        sk.builtin = true;
        sk.path = skillMd;
        byId.set(sk.id, sk);
      } catch (_) {
        /* skip */
      }
    }
  }

  // 2) one user dir can override built-in with same id
  const userMap = new Map();
  for (const d of asDirList(skillDirs)) {
    const root = expandHome(String(d || '').trim());
    if (!isDir(root)) continue;
    for (const skillMd of collectSkillFiles(root, 2)) {
      try {
        const sk = loadSkillFile(skillMd);
        sk.builtin = false;
        if (!userMap.has(sk.id)) userMap.set(sk.id, sk);
      } catch (_) {
        /* skip */
      }
    }
  }

  // user overrides built-in
  for (const [id, sk] of userMap) {
    byId.set(id, sk);
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function loadSkillFromFile(filePath) {
  const p = expandHome(String(filePath || '').trim());
  if (!p || !fs.existsSync(p)) return null;
  try {
    const sk = loadSkillFile(p);
    sk.builtin = false;
    return sk;
  } catch (_) {
    return null;
  }
}

function resolveSkill({ skillId, skillDir, skillDirs } = {}) {
  const dirs = skillDir || skillDirs;
  if (skillId === 'none') return null;
  if (!skillId) {
    return listSkills(dirs).find((s) => s.id === 'gitlab-mr-review') || null;
  }
  return listSkills(dirs).find((s) => s.id === skillId) || null;
}

function skillPromptBlock(opts) {
  const sk = resolveSkill(opts || {});
  if (!sk) return '';
  const body =
    sk.body.length > MAX_SKILL_BODY
      ? `${sk.body.slice(0, MAX_SKILL_BODY)}\n…（技能内容已截断）`
      : sk.body;
  return `
以下是评审技能「${sk.id}」（${sk.name}）的说明${sk.builtin ? '（内置）' : ''}，来源：${sk.path}。
请把它当作本次评审的领域侧重与判断标准之一（若与代码安全/正确性冲突，仍以正确性与安全优先）：

<skill id="${sk.id}" name="${sk.name}">
${body}
</skill>
`.trim();
}

function skillRoots(skillDirs = []) {
  const roots = [builtinSkillsDir()].filter(isDir);
  for (const d of asDirList(skillDirs)) {
    const p = expandHome(String(d || '').trim());
    if (isDir(p)) roots.push(p);
  }
  return roots;
}

module.exports = {
  listSkills,
  resolveSkill,
  getSkill: resolveSkill,
  skillPromptBlock,
  skillRoots,
  builtinSkillsDir,
  loadSkillFromFile,
  parseFrontmatter,
  expandHome,
};
