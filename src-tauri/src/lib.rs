mod config;
mod error;
mod gitlab;
mod review;
mod skills;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands_config_get,
            commands_config_set,
            commands_config_reset,
            commands_gitlab_test,
            commands_gitlab_list_projects,
            commands_gitlab_list_mrs,
            commands_gitlab_get_mr,
            commands_ai_test,
            commands_review_run,
            commands_review_stop,
            commands_review_post,
            commands_skills_list,
            commands_skills_get,
            commands_skills_set_dir,
            commands_skills_clear_dir,
            commands_skills_pick_file,
            commands_app_info,
        ])
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let _ = config::ensure_defaults(&dir);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Glint");
}

// ---- commands ----

#[tauri::command]
fn commands_config_get() -> Result<serde_json::Value, String> {
    config::get_config().map_err(|e| e.to_string())
}

#[tauri::command]
fn commands_config_set(partial: serde_json::Value) -> Result<serde_json::Value, String> {
    config::set_config(partial).map_err(|e| e.to_string())
}

#[tauri::command]
fn commands_config_reset() -> Result<serde_json::Value, String> {
    config::reset_config().map_err(|e| e.to_string())
}

#[tauri::command]
async fn commands_gitlab_test(
    form: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    gitlab::test_gitlab(form.as_ref()).await
}

#[tauri::command]
async fn commands_gitlab_list_projects(
    opts: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    gitlab::list_projects(opts.as_ref()).await
}

#[tauri::command]
async fn commands_gitlab_list_mrs(
    opts: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    gitlab::list_mrs(opts.as_ref()).await
}

#[tauri::command]
async fn commands_gitlab_get_mr(iid: u64) -> Result<serde_json::Value, String> {
    gitlab::get_mr(iid).await
}

#[tauri::command]
async fn commands_ai_test(form: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    review::test_ai(form.as_ref()).await
}

#[tauri::command]
async fn commands_review_run(
    app: tauri::AppHandle,
    opts: serde_json::Value,
) -> Result<serde_json::Value, String> {
    review::run_review(app, opts).await
}

#[tauri::command]
fn commands_review_stop() -> Result<serde_json::Value, String> {
    review::stop_review()
}

#[tauri::command]
async fn commands_review_post(payload: serde_json::Value) -> Result<serde_json::Value, String> {
    review::post_review(payload).await
}

#[tauri::command]
fn commands_skills_list() -> Result<serde_json::Value, String> {
    skills::list_skills_json().map_err(|e| e.to_string())
}

#[tauri::command]
fn commands_skills_get(id: String) -> Result<serde_json::Value, String> {
    skills::get_skill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn commands_skills_set_dir(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    skills::set_dir(app).await
}

#[tauri::command]
fn commands_skills_clear_dir() -> Result<serde_json::Value, String> {
    skills::clear_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn commands_skills_pick_file(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    skills::pick_file(app).await
}

#[tauri::command]
fn commands_app_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "userData": dir,
    }))
}
