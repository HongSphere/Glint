use crate::config::{gitlab_effective, GitLabCreds};
use reqwest::Client;
use serde_json::{json, Value};

fn client() -> Client {
    Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("client")
}

fn api_base(c: &GitLabCreds) -> String {
    let h = c.host.trim().trim_end_matches('/');
    if h.starts_with("http://") || h.starts_with("https://") {
        format!("{}/api/v4", h)
    } else {
        format!("https://{}/api/v4", h)
    }
}

async fn gitlab_get_with(cfg: &GitLabCreds, path: &str) -> Result<Value, String> {
    if cfg.host.is_empty() {
        return Err("请先在设置里填写 GitLab 地址".into());
    }
    if cfg.token.is_empty() {
        return Err("请先在设置里填写 GitLab Token（api scope）".into());
    }
    let url = format!("{}{}", api_base(cfg), path);
    let res = client()
        .get(&url)
        .header("PRIVATE-TOKEN", &cfg.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if status < 200 || status >= 300 {
        return Err(format!("GitLab API 失败 {status}: {}", text.chars().take(300).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| format!("GitLab 响应解析失败: {e}"))
}

async fn gitlab_get(path: &str) -> Result<Value, String> {
    let cfg = gitlab_effective(None);
    gitlab_get_with(&cfg, path).await
}

async fn gitlab_req(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let cfg = gitlab_effective(None);
    if cfg.host.is_empty() || cfg.token.is_empty() {
        return Err("GitLab 未配置".into());
    }
    let url = format!("{}{}", api_base(&cfg), path);
    let mut req = client()
        .request(method, &url)
        .header("PRIVATE-TOKEN", &cfg.token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if status < 200 || status >= 300 {
        return Err(format!("GitLab API 失败 {status}: {}", text.chars().take(400).collect::<String>()));
    }
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub async fn test_gitlab(pending: Option<&Value>) -> Result<Value, String> {
    let cfg = gitlab_effective(pending);
    if cfg.host.is_empty() {
        return Ok(json!({"ok": false, "message": "未配置 GitLab 地址"}));
    }
    if cfg.token.is_empty() {
        return Ok(json!({"ok": false, "message": "未配置 GitLab Token"}));
    }
    match gitlab_get_with(&cfg, "/user").await {
        Ok(user) => {
            let username = user["username"].as_str().unwrap_or(user["name"].as_str().unwrap_or(""));
            let message = if !username.is_empty() {
                format!("已连接 {username}")
            } else {
                "连接成功".to_string()
            };
            Ok(json!({"ok": true, "message": message, "user": {"username": user["username"], "name": user["name"]}}))
        }
        Err(e) => Ok(json!({"ok": false, "message": e})),
    }
}

pub async fn list_projects(opts: Option<&Value>) -> Result<Value, String> {
    let cfg = gitlab_effective(opts.as_ref().and_then(|o| o.get("gitlab")));
    if cfg.host.is_empty() || cfg.token.is_empty() {
        return Err("请先填写主机地址与 Token".into());
    }
    let page = opts
        .and_then(|o| o.get("perPage"))
        .and_then(|v| v.as_u64())
        .unwrap_or(50);
    let q = format!(
        "/projects?membership=true&order_by=last_activity_at&sort=desc&per_page={page}&simple=true"
    );
    let list = gitlab_get_with(&cfg, &q).await?;
    let arr = list.as_array().cloned().unwrap_or_default();
    let out: Vec<Value> = arr
        .iter()
        .map(|p| {
            json!({
                "id": p["id"],
                "path": p["path_with_namespace"],
                "name": p["name"],
                "namespace": p["namespace"]["full_path"].as_str().unwrap_or(""),
                "lastActivityAt": p["last_activity_at"],
                "archived": p["archived"].as_bool().unwrap_or(false),
            })
        })
        .collect();
    Ok(json!(out))
}

pub async fn list_mrs(opts: Option<&Value>) -> Result<Value, String> {
    let cfg = gitlab_effective(None);
    if cfg.project_path.is_empty() {
        return Err("请先在设置里填写项目路径".into());
    }
    let state = opts
        .and_then(|o| o.get("state"))
        .and_then(|v| v.as_str())
        .unwrap_or("opened");
    let enc = urlencoding::encode(&cfg.project_path).to_string();
    let path = format!(
        "/projects/{enc}/merge_requests?state={state}&per_page=50&order_by=updated_at&sort=desc"
    );
    let list = gitlab_get(&path).await?;
    let arr = list.as_array().cloned().unwrap_or_default();
    let out: Vec<Value> = arr
        .iter()
        .map(|mr| {
            json!({
                "iid": mr["iid"],
                "title": mr["title"],
                "sourceBranch": mr["source_branch"],
                "targetBranch": mr["target_branch"],
                "state": mr["state"],
                "author": mr["author"]["username"].as_str().unwrap_or(mr["author"]["name"].as_str().unwrap_or("")),
                "updatedAt": mr["updated_at"],
                "webUrl": mr["web_url"],
                "draft": mr["draft"].as_bool().unwrap_or(mr["work_in_progress"].as_bool().unwrap_or(false)),
            })
        })
        .collect();
    Ok(json!(out))
}

pub async fn get_mr(iid: u64) -> Result<Value, String> {
    let cfg = gitlab_effective(None);
    let enc = urlencoding::encode(&cfg.project_path).to_string();
    let mr = gitlab_get(&format!("/projects/{enc}/merge_requests/{iid}")).await?;
    let changes = gitlab_get(&format!("/projects/{enc}/merge_requests/{iid}/changes")).await?;
    let refs = mr.get("diff_refs").cloned().unwrap_or_else(|| changes["diff_refs"].clone());
    Ok(json!({
        "iid": mr["iid"],
        "projectId": mr["project_id"],
        "title": mr["title"],
        "description": mr["description"],
        "sourceBranch": mr["source_branch"],
        "targetBranch": mr["target_branch"],
        "webUrl": mr["web_url"],
        "state": mr["state"],
        "baseSha": refs["base_sha"],
        "headSha": refs["head_sha"],
        "startSha": refs["start_sha"],
        "changes": changes["changes"],
    }))
}

fn resolve_project_enc(custom_pid: Option<&str>) -> Result<String, String> {
    if let Some(pid) = custom_pid {
        let p = pid.trim();
        if !p.is_empty() && p != "null" {
            return Ok(urlencoding::encode(p).to_string());
        }
    }
    let cfg = gitlab_effective(None);
    if cfg.project_path.trim().is_empty() {
        return Err("未配置 GitLab 项目路径".into());
    }
    Ok(urlencoding::encode(cfg.project_path.trim()).to_string())
}

pub async fn create_note(pid: Option<&str>, iid: u64, body: &str) -> Result<Value, String> {
    let enc = resolve_project_enc(pid)?;
    gitlab_req(
        reqwest::Method::POST,
        &format!("/projects/{enc}/merge_requests/{iid}/notes"),
        Some(json!({ "body": body })),
    )
    .await
}

pub async fn list_discussions(pid: Option<&str>, iid: u64) -> Result<Value, String> {
    let enc = resolve_project_enc(pid)?;
    gitlab_get(&format!("/projects/{enc}/merge_requests/{iid}/discussions?per_page=100")).await
}

pub async fn create_discussion(pid: Option<&str>, iid: u64, payload: Value) -> Result<Value, String> {
    let enc = resolve_project_enc(pid)?;
    gitlab_req(
        reqwest::Method::POST,
        &format!("/projects/{enc}/merge_requests/{iid}/discussions"),
        Some(payload),
    )
    .await
}

pub async fn put_note(pid: Option<&str>, iid: u64, note_id: u64, body: &str) -> Result<Value, String> {
    let enc = resolve_project_enc(pid)?;
    gitlab_req(
        reqwest::Method::PUT,
        &format!("/projects/{enc}/merge_requests/{iid}/notes/{note_id}"),
        Some(json!({ "body": body })),
    )
    .await
}

pub fn project_path_creds() -> GitLabCreds {
    gitlab_effective(None)
}
