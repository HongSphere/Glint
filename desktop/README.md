# Glint 桌面端

GitLab MR AI 评审桌面应用。支持 macOS / Windows。更新需手动触发：菜单或侧栏「检查更新」。

更新源：`https://github.com/HongSphere/Glint`

## 开发

需要 Node.js 20+（推荐 22）。

```bash
cd desktop
npm install
npm start
```

## 打包

```bash
# 当前平台安装包（不发布）
npm run dist:mac    # macOS dmg + zip（x64 + arm64）
npm run dist:win    # Windows nsis
```

产物在 `desktop/release/`。

## 发版（触发自动更新）

1. 提交代码到 `HongSphere/Glint`
2. 递增 `desktop/package.json` 的 `version`（如 `0.1.0` → `0.2.0`）
3. 打 tag 并推送：

```bash
git tag v0.2.0
git push origin v0.2.0
```

4. GitHub Actions `Release` 会构建 mac/win 并上传安装包与 `latest.yml` / `latest-mac.yml`
5. 已安装客户端启动或点「检查更新」时会拉到新版本并提示安装

> 首次发版若 Actions 权限不足，请在仓库 Settings → Actions → Workflow permissions 勾选 **Read and write permissions**。

## 应用内配置

| 分组 | 项 |
|------|----|
| GitLab | 主机、Access Token（api）、项目路径 `group/repo` |
| AI | OpenAI 兼容 Base URL / Key / Model |
| 评审 | 最多问题数、diff 上限、默认 dry-run |
| 更新 | GitHub owner/repo（默认已填 HongSphere/Glint） |

配置保存在系统 userData 目录，不会进 git。

## 使用流程

1. 设置 → 填 GitLab + AI → 分别点「测试连接」
2. 评审 → 刷新 MR → 选中 → 开始评审
3. 默认 **仅预览**；确认后取消勾选再点「写回 GitLab」

## 与 CLI 版关系

仓库根目录的 `scripts/ai_review.py` 仍可作为 CI / 终端方案。  
桌面端是独立实现（纯 Node 调 GitLab REST + OpenAI 兼容 API），**不依赖** 本机 `glab` / Python。
