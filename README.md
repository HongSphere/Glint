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

## 安装包下载

见 [Releases](https://github.com/HongSphere/Glint/releases)。

| 平台 | 选择 |
|------|------|
| macOS Apple Silicon | `Glint-*.dmg` 中带 `arm64` 的包 |
| macOS Intel | 不带 `arm64` 的 `Glint-*.dmg` |
| Windows x64 | `Glint Setup *.exe`（页面上可能显示为 `Glint.Setup.*.exe`） |

## macOS：提示「已损坏」或无法打开

本应用**没有** Apple 开发者签名/公证。macOS 会对从网上下载的应用加上隔离标记（quarantine），Gatekeeper 可能提示：

> “Glint”已损坏，无法打开。你应该将它移到废纸篓。

**不要移到废纸篓**，按下面任一方法处理。

### 方法一：终端去掉隔离标记（推荐）

1. 若已拖到「应用程序」：

```bash
xattr -dr com.apple.quarantine /Applications/Glint.app
```

2. 若还在其他位置（改成你的实际路径）：

```bash
xattr -dr com.apple.quarantine /path/to/Glint.app
```

3. 再双击打开。

### 方法二：系统设置放行

1. 双击打开一次，出现「已损坏 / 无法验证开发者」时点 **取消**（不要移到废纸篓）。
2. 打开 **系统设置 → 隐私与安全性**。
3. 向下找到「仍要打开」/「允许」，点一次并确认。
4. 再启动 Glint。

### 方法三：右键打开（旧版 macOS）

在「应用程序」中 **右键（或按住 Control 点）Glint.app → 打开 → 打开**。  
新版 macOS 可能只剩「已损坏」，请优先用方法一或二。

> 说明：这与安装包是否完整无关，是未签名软件的正常限制。后续若配置 Apple 开发者签名/公证，新版本可直接打开，无需上述步骤。

## 开发

需要 Node.js 20+（推荐 22）。

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

macOS 打包后若需本机 ad-hoc 签名，可对 app 执行：

```bash
codesign --force --deep --sign - /Applications/Glint.app
```

## 发版

1. 改 `desktop/package.json` 的 `version`
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Actions 构建并上传 Release（或手动上传安装包）

仓库：https://github.com/HongSphere/Glint
