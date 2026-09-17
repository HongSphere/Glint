---
name: gitlab-mr-review
description: 用 glab 对 GitLab MR 进行代码评审并回写意见。当用户要求"评审/审查某个 GitLab MR"、"看下这个 Merge Request"、"把评审意见发到 GitLab"、或粘贴 gitlab.com / 自建 GitLab 的 MR 链接时使用。核心流程：读 MR 信息 → 先读历史评论并核对是否已解决 → 通读 diff → 分级评审（附核实结论）→ 按用户选择回写（注记/行内评论/批准）。
---

# GitLab MR 代码评审

## 流程

### 1. 解析 MR 地址
从链接提取三要素：`host`（实例域名）、`project`（`组/项目`，如 `agent/insuranceagent`）、`iid`（数字）。

### 2. 预检环境
- 确认 `glab` 已安装、已认证目标实例：`glab auth status`。
- **自建实例关键坑**：`glab mr` 子命令默认走 gitlab.com，且 `glab mr view` 不支持 `--hostname`。必须用环境变量指定实例：
  ```bash
  export GITLAB_HOST=<自建实例域名>
  ```
  （`glab api` 支持 `--hostname`，`glab mr *` 只认 `GITLAB_HOST`。）

### 3. 读 MR 信息
```bash
glab mr view <iid> -R <project>
```
确认标题、作者、源/目标分支、状态、评论数。

### 4. 先读历史评论并核对是否已解决（必做）
这是评审的第一步，不是最后。拉全部 notes：
```bash
glab api "projects/<project编码>/merge_requests/<iid>/notes?per_page=100&sort=asc"
```
- 逐条总结前人（其他评审者）提出的问题；
- 对每条对照**当前 diff** 判断：已解决 / 部分解决 / 未解决；
- 未解决的在前言里点明，避免重复提出已解决的问题；
- 系统 note（`system=true`）记录 commit/approve 等动作，可用来判断评审后是否有新提交。

### 5. 拉取并通读 diff
```bash
glab mr diff <iid> -R <project> > /tmp/mr_<iid>.diff
```
- 记录文件变更规模（`grep -c '^+++ '`）；
- **完整读取**整个 diff，不要只看摘要；
- 提交后版本可能变化：回写前可用 `shasum` 对比重新拉取的 diff 确认评审对象没过期。

### 6. 必要时拉源码上下文
diff 不足以判断时，用 raw API 抓源码分支的关键文件，核实关键前提（见 review-guidance.md）：
```bash
glab api "projects/<project编码>/repository/files/<文件路径编码>/raw?ref=<分支>"
```
编码规则：路径中每个 `/` 写成 `%2F`（可用 `tr '/' '%2F'`）。

### 7. 输出评审
按严重度分级（🔴 高 / 🟠 中 / 🟡 低/建议）+ **已验证无问题清单**。每条给：文件位置、触发场景、具体建议。规则见 `references/review-guidance.md`。

### 8. 回写（按用户选择）
- 整体注记：`glab mr note create`（**`--message` 已废弃**，用 `glab mr note create <iid> -R <proj> --message "$(cat file)"`，或直接 `glab mr note create`）；
- 行内评论：`glab mr create-comment`；
- 批准：`glab mr approve <iid> -R <project>`。
- 长文本先写文件再 `--message "$(cat file)"` 传入。

## 工具脚本

`scripts/fetch_mr.sh <iid> <project> [output_dir]` — 一次性抓取 MR 信息、全部评论、diff 到临时目录，适合评审开头直接调用。

## 命令速查

完整 glab 命令表见 `references/glab-commands.md`。

## 评审要点

分级标准、常见检查项、自建实例的坑见 `references/review-guidance.md`。
