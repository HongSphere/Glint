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

fn builtin_skills_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for c in [
                parent.join("resources").join("skills"),
                parent.join("skills"),
            ] {
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
    if depth == 0 {
        return;
    }
    let Ok(rd) = fs::read_dir(root) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_file() && name == "SKILL.md" {
            out.push(path);
        } else if path.is_dir() && !name.starts_with('.') && name != "node_modules" {
            collect_skill_files(&path, depth - 1, out);
        }
    }
}

fn load_skill_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    let (meta, body) = parse_frontmatter(&raw);
    let id = meta
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "skill".into())
        });
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

fn list_skills() -> Result<Value, String> {
    let mut final_map = std::collections::BTreeMap::new();
    if let Some(b) = builtin_skills_dir() {
        let mut files = vec![];
        collect_skill_files(&b, 2, &mut files);
        for f in files {
            if let Some(sk) = load_skill_file(&f) {
                let id = sk["id"].as_str().unwrap_or("").to_string();
                let mut sk = sk;
                sk["builtin"] = Value::Bool(true);
                final_map.insert(id, sk);
            }
        }
    }
    let cfg = config::get_config().unwrap_or(json!({}));
    if let Some(dir) = cfg["review"]["skillDir"].as_str() {
        if !dir.is_empty() {
            let mut files = vec![];
            collect_skill_files(Path::new(dir), 2, &mut files);
            for f in files {
                if let Some(sk) = load_skill_file(&f) {
                    let id = sk["id"].as_str().unwrap_or("").to_string();
                    let mut sk = sk;
                    sk["builtin"] = Value::Bool(false);
                    final_map.insert(id, sk);
                }
            }
        }
    }
    let list: Vec<Value> = final_map.into_values().collect();
    Ok(json!(list))
}

fn resolve_skill(id: &str) -> Option<Value> {
    if id == "none" || id.is_empty() {
        return None;
    }
    let list = list_skills().ok()?;
    list.as_array()?
        .iter()
        .find(|s| s["id"].as_str() == Some(id))
        .cloned()
}

fn skill_prompt_block(id: &str) -> String {
    let Some(sk) = resolve_skill(id) else {
        return String::new();
    };
    let mut body = sk["body"].as_str().unwrap_or("").to_string();
    if body.len() > 12000 {
        body = format!("{}\n…（技能内容已截断）", &body[..12000]);
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
    let block = skill_prompt_block(skill_id);
    if block.is_empty() {
        format!("{base}\n当前技能：未加载（使用通用评审默认）\n")
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
