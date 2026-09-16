# Glint

GitLab Merge Request **AI 代码评审**桌面应用（Tauri / macOS / Windows）。

在应用里选择打开中的 MR → AI 审查 diff → 可将总结与行内评论写回仓库。支持自定义技能目录、主题切换。

## 技术栈

- **前端**：`ui/`（HTML / CSS / JS，复用原界面）
- **后端**：Rust（`src-tauri`）— GitLab REST、AI chat、配置、技能、评审
- **壳**：Tauri 2（系统原生 WebView，极低内存与体积占用）

## 开发

需要：Node 20+、Rust、Xcode CLT（macOS）。

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run tauri build -- --bundles app,dmg
```

产物在 `src-tauri/target/release/bundle/`。

macOS 安装包若 DMG 打包失败，可直接分发 `Glint.app` 的 zip：

```bash
zip -r Glint.zip src-tauri/target/release/bundle/macos/Glint.app
```

## 安装包大小

Tauri 产物通常仅 **3 MB** 左右（macOS DMG 约 3.1MB，zip 约 2.5MB）。

## 仓库

https://github.com/HongSphere/Glint
