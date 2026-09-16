use crate::config;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

static CANCEL: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static RUNNING: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

pub fn stop_review() -> Result<Value, String> {
    if !RUNNING.load(Ordering::SeqCst) {
        return Ok(json!({"ok": false, "message": "当前没有进行中的评审"}));
    }
    CANCEL.store(true, Ordering::SeqCst);
    Ok(json!({"ok": true, "message": "已发送停止请求"}))
}

fn cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

const MARKER: &str = "<!-- ai-mr-review -->";

fn skip_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or("");
    let blockers = [
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "cargo.lock",
        "go.sum",
        "composer.lock",
        "gemfile.lock",
    ];
    if blockers.iter().any(|b| name == *b) {
        return true;
    }
    let dirs = ["dist/", "build/", "vendor/", "node_modules/"];
    if dirs.iter().any(|d| lower.contains(d)) || lower.contains(".min.js") || lower.contains(".min.css") {
        return true;
    }
    let exts = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".woff", ".woff2",
        ".ttf", ".eot", ".mp4", ".mp3", ".wav",
    ];
    exts.iter().any(|e| lower.ends_with(e))
}

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
    // resource dir next to exe, or src-tauri/skills in dev
    if let Ok(d) = std::env::current_exe() {
        let cands = [
            d.parent().map(|p| p.join("resources").join("skills")).unwrap_or_default(),
            d.parent().map(|p| p.join("skills")).unwrap_or_default(),
        ];
        for c in cands {
            if c.is_dir() {
                return Some(c);
            }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("skills");
    if dev.is_dir() {
        return Some(dev);
    }
    None
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
    let mut by_id = std::collections::BTreeMap::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(b) = builtin_skills_dir() {
        roots.push(b);
    }
    let cfg = config::get_config().unwrap_or(json!({}));
    if let Some(dir) = cfg["review"]["skillDir"].as_str() {
        if !dir.is_empty() {
            let p = PathBuf::from(dir);
            if p.is_dir() {
                roots.push(p);
            }
        }
    }
    // user overrides builtin
    let mut ordered = roots;
    // actually collect builtin first then user later overwrites via insert only if not present - user last
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
    by_id = final_map;
    let list: Vec<Value> = by_id.into_values().collect();
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
    let body = sk["body"].as_str().unwrap_or("").to_string();
    let body = if body.len() > 12000 {
        format!("{}\n…（技能内容已截断）", &body[..12000])
    } else {
        body
    };
    let name = sk["name"].as_str().unwrap_or("");
    format!(
        "以下是评审技能「{id}」（{name}）的说明。请把它当作本次评审的领域侧重之一（正确性与安全优先）：\n\n<skill id=\"{id}\" name=\"{name}\">\n{body}\n</skill>"
    )
}

fn system_prompt(skill_id: &str) -> String {
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

fn parse_review_json(text: &str) -> Result<Value, String> {
    let mut t = text.trim();
    if t.starts_with("```") {
        t = t
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
    }
    let mut data: Value = serde_json::from_str(t).map_err(|e| format!("AI 输出无法解析为 JSON: {e}"))?;
    let obj = data.as_object_mut().ok_or("AI 输出不是 JSON 对象")?;
    obj.entry("summary").or_insert(json!(""));
    obj.entry("verdict").or_insert(json!("comment"));
    if obj.get("score").is_none() {
        obj.insert("score".into(), json!(5));
    }
    if !obj.contains_key("positives") {
        obj.insert("positives".into(), json!([]));
    }
    if !obj.contains_key("issues") {
        obj.insert("issues".into(), json!([]));
    }
    Ok(data)
}

fn valid_line(diff: &str, side: &str, line: i64) -> bool {
    if line <= 0 {
        return false;
    }
    let (mut old_ln, mut new_ln) = (0i64, 0i64);
    for raw in diff.lines() {
        if raw.starts_with("+++") || raw.starts_with("---") {
            continue;
        }
        if raw.starts_with("@@") {
            // @@ -a,b +c,d @@
            let re = regex::Regex::new(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap();
            if let Some(c) = re.captures(raw) {
                old_ln = c[1].parse().unwrap_or(0);
                new_ln = c[2].parse().unwrap_or(0);
            } else {
                return false;
            }
            continue;
        }
        if let Some(rest) = raw.strip_prefix('+') {
            let _ = rest;
            if side == "new" && new_ln == line {
                return true;
            }
            new_ln += 1;
        } else if raw.starts_with('-') {
            if side == "old" && old_ln == line {
                return true;
            }
            old_ln += 1;
        } else if raw.starts_with('\\') {
            continue;
        } else {
            if side == "new" && new_ln == line {
                return true;
            }
            if side == "old" && old_ln == line {
                return true;
            }
            old_ln += 1;
            new_ln += 1;
        }
    }
    false
}

pub async fn test_ai(pending: Option<&Value>) -> Result<Value, String> {
    let ai = config::ai_effective(pending);
    if ai.api_key.is_empty() {
        return Ok(json!({"ok": false, "message": "未填写 AI API Key"}));
    }
    let url = format!("{}/chat/completions", ai.base_url);
    let body = json!({
        "model": ai.model,
        "messages": [
            {"role":"system","content":"只输出 JSON {\"ok\":true}"},
            {"role":"user","content":"pong"}
        ]
    });
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .bearer_auth(&ai.api_key)
        .json(&body)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => Ok(json!({"ok": true, "message": format!("模型可调用: {}", ai.model)})),
        Ok(r) => {
            let status = r.status();
            let t = r.text().await.unwrap_or_default();
            Ok(json!({"ok": false, "message": format!("HTTP {}: {}", status, t.chars().take(200).collect::<String>())}))
        }
        Err(e) => Ok(json!({"ok": false, "message": e.to_string()})),
    }
}

pub async fn run_review(app: AppHandle, opts: Value) -> Result<Value, String> {
    let iid = opts["iid"].as_u64().unwrap_or(0);
    if iid == 0 {
        return Err("请选择要评审的 MR".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    RUNNING.store(true, Ordering::SeqCst);
    let result = run_review_inner(&app, iid).await;
    RUNNING.store(false, Ordering::SeqCst);
    CANCEL.store(false, Ordering::SeqCst);
    result
}

async fn run_review_inner(app: &AppHandle, iid: u64) -> Result<Value, String> {
    emit(app, "ai", &format!("拉取 MR !{iid} …"));
    let mr = crate::gitlab::get_mr(iid).await?;
    if cancelled() {
        return Err("请求已取消".into());
    }
    let state = mr["state"].as_str().unwrap_or("");
    if !state.is_empty() && state != "opened" {
        return Err(format!("仅支持评审打开中的 MR（当前状态: {state}）"));
    }
    emit(app, "diff", "读取变更…");
    let changes = mr["changes"].as_array().cloned().unwrap_or_default();
    let mut diff_parts = String::new();
    let mut used = 0usize;
    for ch in &changes {
        let path = ch["new_path"]
            .as_str()
            .unwrap_or_else(|| ch["old_path"].as_str().unwrap_or(""))
            .to_string();
        if path.is_empty() || skip_path(&path) {
            continue;
        }
        let d = ch["diff"].as_str().unwrap_or("");
        if d.trim().is_empty() {
            continue;
        }
        diff_parts.push_str(&format!("### FILE: {path}\n{d}\n"));
        used += 1;
    }
    if diff_parts.trim().is_empty() {
        return Ok(json!({"ok": true, "empty": true, "message": "无可评审 diff", "review": null, "mr": mr}));
    }
    if cancelled() {
        return Err("请求已取消".into());
    }
    let (skill_id, _) = config::review_opts();
    emit(app, "ai", &format!("调用模型评审 {used} 个文件…"));
    let system = system_prompt(&skill_id);
    let user = format!(
        "请评审以下 Merge Request。\n\n## MR 元信息\n- 标题: {}\n- 分支: {} → {}\n- 链接: {}\n\n## MR 描述\n{}\n\n## Diff\n{}\n\n请输出严格 JSON。",
        mr["title"].as_str().unwrap_or(""),
        mr["sourceBranch"].as_str().unwrap_or(""),
        mr["targetBranch"].as_str().unwrap_or(""),
        mr["webUrl"].as_str().unwrap_or(""),
        mr["description"].as_str().unwrap_or("（空）"),
        diff_parts
    );
    let ai = config::ai_effective(None);
    if ai.api_key.is_empty() {
        return Err("请先在设置里填写 AI API Key".into());
    }
    let url = format!("{}/chat/completions", ai.base_url);
    let body = json!({
        "model": ai.model,
        "messages": [
            {"role":"system","content":system},
            {"role":"user","content":user}
        ]
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    // poll cancel with tokio
    let res = tokio::select! {
        r = client.post(&url).bearer_auth(&ai.api_key).json(&body).send() => r,
        _ = async {
            while !cancelled() {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        } => return Err("请求已取消".into()),
    };
    let res = res.map_err(|e| e.to_string())?;
    if cancelled() {
        return Err("请求已取消".into());
    }
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("AI API 调用失败 {status}: {}", text.chars().take(300).collect::<String>()));
    }
    let payload: Value = serde_json::from_str(&text).map_err(|e| format!("AI 响应解析失败: {e}"))?;
    let content = payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if content.is_empty() {
        return Err("AI 响应结构异常".into());
    }
    if cancelled() {
        return Err("请求已取消".into());
    }
    let review = parse_review_json(&content)?;
    emit(app, "done", "评审完成");
    Ok(json!({"ok": true, "empty": false, "mr": mr, "review": review}))
}

fn emit(app: &AppHandle, step: &str, message: &str) {
    let _ = app.emit(
        "review:progress",
        json!({ "step": step, "message": message }),
    );
}

pub async fn post_review(payload: Value) -> Result<Value, String> {
    let iid = payload["iid"].as_u64().unwrap_or(0);
    let review = payload.get("review").cloned().unwrap_or(json!({}));
    let skip_inline = payload["skipInline"].as_bool().unwrap_or(false);
    if iid == 0 {
        return Err("缺少 MR 编号".into());
    }
    let mr = crate::gitlab::get_mr(iid).await?;
    let state = mr["state"].as_str().unwrap_or("");
    if !state.is_empty() && state != "opened" {
        return Err(format!("仅支持写回打开中的 MR（当前状态: {state}）"));
    }

    let mut lines = vec![
        MARKER.to_string(),
        format!(
            "## AI Code Review · {} · {}/10",
            review["verdict"].as_str().unwrap_or("comment"),
            review["score"].as_i64().unwrap_or(5)
        ),
        String::new(),
        review["summary"].as_str().unwrap_or("").to_string(),
        String::new(),
    ];
    if let Some(pos) = review["positives"].as_array() {
        if !pos.is_empty() {
            lines.push("**亮点**".into());
            for p in pos.iter().take(8) {
                lines.push(format!("- {}", p.as_str().unwrap_or("")));
            }
            lines.push(String::new());
        }
    }
    let mut _summary_action = "created".to_string();
    if let Some(arr) = review["issues"].as_array() {
        if !arr.is_empty() {
            lines.push("**问题摘要**".into());
            for (i, iss) in arr.iter().take(30).enumerate() {
                let loc = format!(
                    "{}{}",
                    iss["file"].as_str().unwrap_or(""),
                    if iss["line"].as_i64().is_some() {
                        format!(":{}", iss["line"].as_i64().unwrap())
                    } else {
                        String::new()
                    }
                );
                lines.push(format!(
                    "{}. [{}] {} — `{}`",
                    i + 1,
                    iss["severity"].as_str().unwrap_or("medium"),
                    iss["title"].as_str().unwrap_or("issue"),
                    loc
                ));
            }
            lines.push(String::new());
            lines.push("详细见行内评论（若有）。".into());
        } else {
            lines.push("未发现需要阻塞合并的问题。".into());
        }
    }

    // update existing marker note if any
    let discussions = crate::gitlab::list_discussions(iid).await?;
    let mut updated = false;
    if let Some(ds) = discussions.as_array() {
        'outer: for d in ds {
            if let Some(notes) = d["notes"].as_array() {
                for n in notes {
                    if n["body"].as_str().unwrap_or("").contains(MARKER) {
                        let note_id = n["id"].as_u64().unwrap_or(0);
                        let _ = crate::gitlab::put_note(iid, note_id, &lines.join("\n")).await?;
                        updated = true;
                        break 'outer;
                    }
                }
            }
        }
    }
    if !updated {
        let _ = crate::gitlab::create_note(iid, &lines.join("\n")).await?;
    }

    let mut inline_count = 0u64;
    if !skip_inline {
        let refs = json!({
            "base_sha": mr["baseSha"],
            "head_sha": mr["headSha"],
            "start_sha": mr["startSha"],
        });
        let has_refs = refs["base_sha"].as_str().unwrap_or("").len() > 0
            && refs["head_sha"].as_str().unwrap_or("").len() > 0
            && refs["start_sha"].as_str().unwrap_or("").len() > 0;
        if has_refs {
            if let Some(issues) = review["issues"].as_array() {
                for iss in issues {
                    if inline_count >= 15 {
                        break;
                    }
                    let file = iss["file"].as_str().unwrap_or("");
                    if file.is_empty() {
                        continue;
                    }
                    let ch = match mr["changes"]
                        .as_array()
                        .and_then(|arr| {
                            arr.iter().find(|c| {
                                c["new_path"].as_str() == Some(file)
                                    || c["old_path"].as_str() == Some(file)
                            })
                        })
                    {
                        Some(c) => c.clone(),
                        None => continue,
                    };
                    let side = iss["side"].as_str().unwrap_or("new");
                    let line = iss["line"].as_i64().unwrap_or(0);
                    let diff = ch["diff"].as_str().unwrap_or("");
                    if !valid_line(diff, side, line) {
                        continue;
                    }
                    let mut position = json!({
                        "position_type": "text",
                        "base_sha": refs["base_sha"],
                        "head_sha": refs["head_sha"],
                        "start_sha": refs["start_sha"],
                    });
                    if side == "new" {
                        position["new_path"] = json!(file);
                        position["new_line"] = json!(line);
                        if ch["renamed_file"].as_bool().unwrap_or(false) {
                            position["old_path"] = ch["old_path"].clone();
                        }
                    } else {
                        position["old_path"] = json!(file);
                        position["old_line"] = json!(line);
                        position["new_path"] = ch["new_path"].clone();
                    }
                    let body = format!(
                        "**[{}] {}**\n\n{}",
                        iss["severity"].as_str().unwrap_or("medium"),
                        iss["title"].as_str().unwrap_or("Issue"),
                        iss["body"].as_str().unwrap_or("")
                    );
                    if crate::gitlab::create_discussion(iid, json!({"body": body, "position": position}))
                        .await
                        .is_ok()
                    {
                        inline_count += 1;
                    }
                }
            }
        }
    }

    Ok(json!({
        "ok": true,
        "summaryAction": if updated { "updated" } else { "created" },
        "inlineCount": inline_count,
        "webUrl": mr["webUrl"],
    }))
}
