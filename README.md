# Glint

GitLab Merge Request **AI 代码评审**桌面应用（macOS / Windows）。

在应用里选择打开中的 MR → AI 审查 diff → 可将总结与行内评论写回仓库。支持自定义技能目录、主题切换，以及从 GitHub Releases **手动检查更新**。

## 功能

- 连接自建 GitLab（Access Token `api`），加载项目与打开中的 MR
- OpenAI 兼容模型评审（默认火山方舟 coding 接口）
- 评审结果面板；可勾选评审后自动写回
- 可选自定义技能（`<目录>/<skill-id>/SKILL.md`）
- 主题：跟随系统 / 浅色 / 深色
- 更新：仅手动「检查更新」，源为 GitHub Releases

## 开发

```bash
cd desktop
npm install
npm start
```

## 打包

```bash
npm run dist:mac   # dmg + zip（x64 / arm64）
npm run dist:win   # Windows NSIS
```

## 安装包下载

见 [Releases](https://github.com/HongSphere/Glint/releases)。

- macOS：Apple Silicon 用 `*-arm64.dmg`，Intel 用 `Glint-*.dmg`
- Windows：`Glint Setup *.exe`（Release 里可能显示为 `Glint.Setup.*.exe`）

本机若未做 Apple 签名，首次打开可能需右键「打开」。

## 发版

1. 改 `desktop/package.json` 的 `version`
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Actions 会构建并上传 Release（或手动传安装包）

仓库：https://github.com/HongSphere/Glint
