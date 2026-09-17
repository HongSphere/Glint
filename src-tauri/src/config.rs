use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static CONFIG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static PENDING_GITLAB: Lazy<Mutex<Option<Value>>> = Lazy::new(|| Mutex::new(None));
static PENDING_AI: Lazy<Mutex<Option<Value>>> = Lazy::new(|| Mutex::new(None));

fn default_config() -> Value {
    json!({
        "gitlab": { "host": "", "token": "", "projectPath": "" },
        "ai": {
            "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
            "apiKey": "",
            "model": "ark-code-latest"
        },
        "review": { "skipInline": false, "skillId": "glint-mr-review", "skillDir": "" },
        "update": { "owner": "HongSphere", "repo": "Glint", "channel": "latest" },
        "ui": { "theme": "system" },
        "cache": {
            "projects": [],
            "projectsHost": "",
            "projectsTokenSig": "",
            "projectsAt": 0
        }
    })
}

fn config_path() -> std::io::Result<PathBuf> {
    if let Some(p) = CONFIG_PATH.lock().unwrap().clone() {
        return Ok(p);
    }
    let dir = dirs::config_dir()
        .ok_or_else(|| std::io::Error::other("no config dir"))?
        .join("com.hongsphere.glint");
    fs::create_dir_all(&dir)?;
    let path = dir.join("config.json");
    *CONFIG_PATH.lock().unwrap() = Some(path.clone());
    Ok(path)
}

fn load() -> Value {
    let path = match config_path() {
        Ok(p) => p,
        Err(_) => return default_config(),
    };
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| default_config()),
        Err(_) => default_config(),
    }
}

fn save(v: &Value) -> std::io::Result<()> {
    let path = config_path()?;
    fs::write(path, serde_json::to_string_pretty(v).map_err(|e| std::io::Error::other(e))?)
}

pub fn ensure_defaults(dir: &Path) -> std::io::Result<()> {
    *CONFIG_PATH.lock().unwrap() = Some(dir.join("config.json"));
    let path = config_path()?;
    if !path.exists() {
        save(&default_config())?;
    }
    Ok(())
}

pub fn get_config() -> Result<Value, String> {
    Ok(load())
}

pub fn set_config(partial: Value) -> Result<Value, String> {
    let current = load();
    let next = deep_merge(current, partial);
    save(&next).map_err(|e| e.to_string())?;
    Ok(next)
}

pub fn reset_config() -> Result<Value, String> {
    let d = default_config();
    save(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn deep_merge(base: Value, patch: Value) -> Value {
    match (base, patch) {
        (Value::Object(mut b), Value::Object(p)) => {
            for (k, v) in p {
                match b.remove(&k) {
                    Some(old) if old.is_object() && v.is_object() => {
                        b.insert(k, deep_merge(old, v));
                    }
                    _ => {
                        b.insert(k, v);
                    }
                }
            }
            Value::Object(b)
        }
        (_, p) => p,
    }
}

pub fn set_pending_gitlab(v: Option<Value>) {
    *PENDING_GITLAB.lock().unwrap() = v;
}

pub fn set_pending_ai(v: Option<Value>) {
    *PENDING_AI.lock().unwrap() = v;
}

pub fn normalize_host(host: &str) -> String {
    let h = host.trim().trim_end_matches('/');
    let h = h
        .strip_prefix("https://")
        .or_else(|| h.strip_prefix("http://"))
        .unwrap_or(h);
    h.trim_end_matches('/').to_string()
}

pub fn gitlab_effective(pending: Option<&Value>) -> GitLabCreds {
    let cfg = load();
    let base = cfg.get("gitlab").cloned().unwrap_or(json!({}));
    let base_host = normalize_host(base["host"].as_str().unwrap_or(""));
    let base_token = base["token"].as_str().unwrap_or("").trim().to_string();
    let base_project = base["projectPath"].as_str().unwrap_or("").trim().to_string();
    let pending_owned = pending.cloned();
    let locked = PENDING_GITLAB.lock().unwrap().clone();
    let p = pending_owned.as_ref().or(locked.as_ref());
    match p {
        Some(p) => GitLabCreds {
            host: normalize_host(
                p["host"]
                    .as_str()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&base_host),
            ),
            token: p["token"]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(base_token),
            project_path: p["projectPath"]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(base_project),
        },
        None => GitLabCreds {
            host: base_host,
            token: base_token,
            project_path: base_project,
        },
    }
}

pub fn ai_effective(pending: Option<&Value>) -> AiCreds {
    let cfg = load();
    let base = cfg.get("ai").cloned().unwrap_or(json!({}));
    let base_url = base["baseUrl"]
        .as_str()
        .unwrap_or("https://ark.cn-beijing.volces.com/api/coding/v3")
        .trim()
        .trim_end_matches('/')
        .to_string();
    let base_key = base["apiKey"].as_str().unwrap_or("").trim().to_string();
    let base_model = base["model"].as_str().unwrap_or("ark-code-latest").to_string();
    let pending_owned = pending.cloned();
    let locked = PENDING_AI.lock().unwrap().clone();
    let p = pending_owned.as_ref().or(locked.as_ref());
    match p {
        Some(p) => AiCreds {
            base_url: p["baseUrl"]
                .as_str()
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(base_url),
            api_key: p["apiKey"]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(base_key),
            model: p["model"]
                .as_str()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(base_model),
        },
        None => AiCreds {
            base_url,
            api_key: base_key,
            model: base_model,
        },
    }
}

pub fn review_opts() -> (String, String) {
    let cfg = load();
    let r = cfg.get("review").cloned().unwrap_or(json!({}));
    let skill_id = r["skillId"]
        .as_str()
        .map(|s| if s == "gitlab-mr-review" { "glint-mr-review" } else { s })
        .unwrap_or("glint-mr-review")
        .to_string();
    let skill_dir = r["skillDir"].as_str().unwrap_or("").to_string();
    (skill_id, skill_dir)
}

#[derive(Clone)]
pub struct GitLabCreds {
    pub host: String,
    pub token: String,
    pub project_path: String,
}

#[derive(Clone)]
pub struct AiCreds {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}
