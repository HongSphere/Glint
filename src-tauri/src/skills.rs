use crate::config;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

fn parse_frontmatter(raw: &str) -> (Value, String) {
    let text = raw.trim_start_matches('\u{feff}');
    if !text.starts_with("---") {
        return (json!({}), text.to_string());
    }
    let end = match text.find("\n---") {
        Some(i) => i,
        None => return (json!({}), text.to_string()),
    };
    let fm = text[3..end].trim();
    let body = text[end + 4..].trim_start_matches('\n').to_string();
    let mut meta = serde_json::Map::new();
    for line in fm.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim().to_string();
            let mut v = v.trim().to_string();
            if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
                v = v[1..v.len() - 1].to_string();
            }
            meta.insert(k.to_lowercase(), Value::String(v));
        }
    }
    (Value::Object(meta), body)
}

const DEFAULT_SKILL_GITLAB_MR: &str = include_str!("../skills/glint-mr-review/SKILL.md");
const DEFAULT_SKILL_GUIDANCE: &str = include_str!("../skills/glint-mr-review/references/review-guidance.md");

fn embedded_builtin_skills() -> Vec<Value> {
    let mut out = Vec::new();
    let (meta, mut body) = parse_frontmatter(DEFAULT_SKILL_GITLAB_MR);
    if !DEFAULT_SKILL_GUIDANCE.is_empty() {
        body.push_str("\n\n## 技能参考资料 (References)\n\n### 参考文档: review-guidance.md\n\n");
        body.push_str(DEFAULT_SKILL_GUIDANCE);
    }
    let id = meta
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("glint-mr-review")
        .to_string();
    let title = body
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l[2..].trim().to_string())
        .unwrap_or_else(|| "Glint MR Review".to_string());
    out.push(json!({
        "id": id,
        "name": title,
        "description": meta.get("description").cloned().unwrap_or(json!("Glint Merge Request AI 代码评审专家。具备多语言全栈工程审查能力，输出结构化 JSON。")),
        "path": "builtin://glint-mr-review",
        "body": body,
        "builtin": true,
    }));
    out
}

fn builtin_skills_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let mut cands = vec![
                parent.join("resources").join("skills"),
                parent.join("skills"),
            ];
            // macOS App Bundle: Glint.app/Contents/MacOS/glint -> parent.parent() is Glint.app/Contents
            if let Some(contents) = parent.parent() {
                cands.push(contents.join("Resources").join("skills"));
                cands.push(contents.join("resources").join("skills"));
            }
            for c in cands {
                if c.is_dir() {
                    return Some(c);
                }
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skills");
    if dev.is_dir() {
        Some(dev)
    } else {
        None
    }
}

fn collect_skill_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if root.is_file() {
        let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let lower = name.to_lowercase();
        if lower.ends_with(".md") || lower == "skill" || lower.contains("review") {
            out.push(root.to_path_buf());
        }
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(rd) = fs::read_dir(root) else { return };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if path.is_file() {
            if lower == "skill.md" || lower.ends_with(".skill.md") || (lower.ends_with(".md") && lower != "readme.md") {
                out.push(path);
            }
        } else if path.is_dir()
            && !name.starts_with('.')
            && name != "node_modules"
            && name != "references"
            && name != "scripts"
            && name != "assets"
        {
            collect_skill_files(&path, depth - 1, out);
        }
    }
}

fn load_skill_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    let (meta, mut body) = parse_frontmatter(&raw);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let id = meta
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if stem.to_lowercase() == "skill" {
                path.parent()
                    .and_then(|p| p.file_name())
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "skill".into())
            } else {
                stem.clone()
            }
        });

    // Auto-attach companion references (e.g. references/review-guidance.md) if present
    if let Some(parent) = path.parent() {
        let ref_dir = parent.join("references");
        if ref_dir.is_dir() {
            if let Ok(rd) = fs::read_dir(ref_dir) {
                let mut ref_paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                ref_paths.sort();
                let mut ref_blocks = Vec::new();
                for p in ref_paths {
                    if p.is_file() && p.extension().map(|e| e == "md").unwrap_or(false) {
                        let fname = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                        if let Ok(content) = fs::read_to_string(&p) {
                            if !content.trim().is_empty() {
                                ref_blocks.push(format!("### 参考文档: {fname}\n\n{content}"));
                            }
                        }
                    }
                }
                if !ref_blocks.is_empty() {
                    body.push_str("\n\n## 技能参考资料 (References)\n\n");
                    body.push_str(&ref_blocks.join("\n\n---\n\n"));
                }
            }
        }
    }

    let title = body
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l[2..].trim().to_string())
        .unwrap_or_else(|| id.clone());
    Some(json!({
        "id": id,
        "name": title,
        "description": meta.get("description").cloned().unwrap_or(json!("")),
        "path": path.to_string_lossy(),
        "body": body,
    }))
}

pub fn list_skills() -> Result<Value, String> {
    let mut final_map = std::collections::BTreeMap::new();

    // 1. Embedded fallback/default skills (always available across all platforms)
    for sk in embedded_builtin_skills() {
        let id = sk["id"].as_str().unwrap_or("").to_string();
        final_map.insert(id, sk);
    }

    // 2. Extra built-in skills on disk if present
    if let Some(b) = builtin_skills_dir() {
        let mut files = vec![];
        collect_skill_files(&b, 2, &mut files);
        for f in files {
            if let Some(mut sk) = load_skill_file(&f) {
                let id = sk["id"].as_str().unwrap_or("").to_string();
                sk["builtin"] = Value::Bool(true);
                final_map.insert(id, sk);
            }
        }
    }

    // 3. User custom skillDir overrides or additions
    let cfg = config::get_config().unwrap_or(json!({}));
    if let Some(dir) = cfg["review"]["skillDir"].as_str() {
        if !dir.is_empty() {
            let mut files = vec![];
            collect_skill_files(Path::new(dir), 2, &mut files);
            for f in files {
                if let Some(mut sk) = load_skill_file(&f) {
                    let id = sk["id"].as_str().unwrap_or("").to_string();
                    sk["builtin"] = Value::Bool(false);
                    final_map.insert(id, sk);
                }
            }
        }
    }
    let list: Vec<Value> = final_map.into_values().collect();
    Ok(json!(list))
}

pub fn resolve_skill(id: &str) -> Option<Value> {
    if id == "none" || id.is_empty() {
        return None;
    }
    let actual_id = if id == "gitlab-mr-review" {
        "glint-mr-review"
    } else {
        id
    };
    let list = list_skills().ok()?;
    list.as_array()?
        .iter()
        .find(|s| s["id"].as_str() == Some(actual_id) || s["id"].as_str() == Some(id))
        .cloned()
}

pub fn skill_prompt_block(id: &str) -> String {
    let Some(sk) = resolve_skill(id) else {
        return String::new();
    };
    let mut body = sk["body"].as_str().unwrap_or("").to_string();
    let max_chars = 12000;
    if body.chars().count() > max_chars {
        let truncated: String = body.chars().take(max_chars).collect();
        body = format!("{truncated}\n…（技能内容已截断）");
    }
    let name = sk["name"].as_str().unwrap_or("");
    format!(
        "以下是评审技能「{id}」（{name}）的说明。请把它当作本次评审的领域侧重之一（正确性与安全优先）：\n\n<skill id=\"{id}\" name=\"{name}\">\n{body}\n</skill>"
    )
}

pub fn system_prompt(skill_id: &str) -> String {
    let base = r#"你是资深代码评审员，负责 GitLab Merge Request 评审。
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
"#;
    if skill_id == "none" || skill_id.is_empty() {
        return format!("{base}\n当前技能模式：通用评审（未挂载特定技能）\n");
    }
    let block = skill_prompt_block(skill_id);
    if block.is_empty() {
        format!("{base}\n当前技能模式：{skill_id}（技能定义未找到，回退通用评审）\n")
    } else {
        format!("{base}\n当前技能：{skill_id}\n\n{block}\n")
    }
}

pub fn list_skills_json() -> Result<Value, String> {
    list_skills()
}

pub fn list_skills_cmd() -> Result<Value, String> {
    list_skills()
}

pub fn get_skill(id: &str) -> Result<Value, String> {
    match resolve_skill(id) {
        Some(sk) => {
            let mut body = sk["body"].as_str().unwrap_or("").to_string();
            let preview: String = body.chars().take(800).collect();
            body.clear();
            Ok(json!({
                "id": sk["id"],
                "name": sk["name"],
                "description": sk["description"],
                "path": sk["path"],
                "builtin": sk["builtin"],
                "bodyPreview": preview,
            }))
        }
        None => Ok(Value::Null),
    }
}

pub async fn set_dir(app: AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let dir = app
        .dialog()
        .file()
        .blocking_pick_folder();
    let Some(dir) = dir else {
        return Ok(Value::Null);
    };
    let path = dir.to_string();
    config::set_config(json!({"review": {"skillDir": path}})).map_err(|e| e.to_string())?;
    Ok(config::get_config().map_err(|e| e.to_string())?["review"]["skillDir"].clone())
}

pub fn clear_dir() -> Result<Value, String> {
    config::set_config(json!({"review": {"skillDir": ""}})).map_err(|e| e.to_string())?;
    Ok(json!(true))
}

pub async fn pick_file(app: AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app
        .dialog()
        .file()
        .set_file_name("SKILL.md")
        .blocking_pick_file();
    let Some(file) = file else {
        return Ok(Value::Null);
    };
    let path = file.to_string();
    config::set_config(json!({"review": {"skillId": "file", "skillFile": path}}))
        .map_err(|e| e.to_string())?;
    Ok(Value::String(path))
}

// unused re-exports removed; commands call functions directly

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_skill_always_available() {
        let skills = list_skills().expect("list_skills should succeed");
        let arr = skills.as_array().expect("skills should be an array");
        assert!(!arr.is_empty(), "skills array should never be empty");
        let default_skill = arr.iter().find(|s| s["id"] == "glint-mr-review");
        assert!(default_skill.is_some(), "glint-mr-review must be present");
        let sk = default_skill.unwrap();
        assert_eq!(sk["builtin"], true);
        let body = sk["body"].as_str().unwrap_or("");
        assert!(!body.is_empty());
        assert!(body.contains("review-guidance.md"), "skill body must include review-guidance reference");
        assert!(body.contains("高"), "skill body must include severity guidance");

        // backward compatibility alias check
        let resolved_alias = resolve_skill("gitlab-mr-review");
        assert!(resolved_alias.is_some(), "gitlab-mr-review alias must resolve");
        assert_eq!(resolved_alias.unwrap()["id"], "glint-mr-review");

        let prompt = system_prompt("glint-mr-review");
        assert!(prompt.contains("GitLab Merge Request 评审"));
        assert!(prompt.contains("<skill id=\"glint-mr-review\""));
        assert!(prompt.contains("review-guidance.md"));
    }

    #[test]
    fn test_custom_skill_package_with_references() {
        let temp_dir = std::env::temp_dir().join(format!("glint_skill_test_{}", std::process::id()));
        let skill_dir = temp_dir.join("my-awesome-skill");
        let ref_dir = skill_dir.join("references");
        let script_dir = skill_dir.join("scripts");
        fs::create_dir_all(&ref_dir).unwrap();
        fs::create_dir_all(&script_dir).unwrap();

        fs::write(skill_dir.join("SKILL.md"), "---\nname: my-awesome-skill\ndescription: Custom test skill\n---\n# My Awesome Skill\nCore skill body").unwrap();
        fs::write(ref_dir.join("security-rules.md"), "# Security Rules\nCheck for SQL injection").unwrap();
        fs::write(script_dir.join("helper.sh"), "#!/bin/bash\necho helper").unwrap();

        let mut collected = Vec::new();
        collect_skill_files(&temp_dir, 2, &mut collected);
        // Only SKILL.md should be collected, not security-rules.md or helper.sh
        assert_eq!(collected.len(), 1, "Only SKILL.md should be collected as skill entry");

        let loaded = load_skill_file(&collected[0]).expect("load_skill_file should succeed");
        assert_eq!(loaded["id"], "my-awesome-skill");
        let body = loaded["body"].as_str().unwrap_or("");
        assert!(body.contains("Core skill body"));
        assert!(body.contains("## 技能参考资料 (References)"));
        assert!(body.contains("security-rules.md"));
        assert!(body.contains("Check for SQL injection"));

        let _ = fs::remove_dir_all(temp_dir);
    }
}
