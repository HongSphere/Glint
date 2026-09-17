# glab 命令速查（MR 评审场景）

## 环境

```bash
# 自建实例必须设置（glab 默认走 gitlab.com；glab mr * 不支持 --hostname，只认此环境变量）
export GITLAB_HOST=code.meibaokeji.com

glab auth status        # 确认登录状态（token 存在 OS keyring）
glab auth login --hostname <域名> --token <PAT>   # 认证自建实例
```

## MR 信息

```bash
glab mr view <iid> -R <project>
glab mr view <iid> -R <project> --comments     # 附带评论
glab mr list -R <project>                       # 列表
```

## 历史评论（评审第一步必做）

```bash
# 全部 notes（含系统 note：commit/approve 动作）
glab api "projects/<project编码>/merge_requests/<iid>/notes?per_page=100&sort=asc"
# 逐条解析: python3 -c "import sys,json; [print(n['id'], n['author']['username'], n['created_at'], 'system='+str(n['system']), '::', n['body'][:200]) for n in json.load(sys.stdin)]"
```

编码：`agent/insuranceagent` → `agent%2Finsuranceagent`（`tr '/' '%2F'`）。

## diff

```bash
glab mr diff <iid> -R <project> > /tmp/mr_<iid>.diff   # 统一 diff
grep -c '^+++ ' /tmp/mr_<iid>.diff                      # 变更文件数
shasum /tmp/mr_<iid>.diff                               # 校验版本（回写前对比是否过期）
```

## 拉源码文件（diff 不足以判断时）

```bash
glab api "projects/<project编码>/repository/files/<文件路径编码>/raw?ref=<分支>"
# 例（文件路径也做 %2F 编码）:
glab api "projects/agent%2Finsuranceagent/repository/files/insuranceagent-safety%2Fsrc%2Fmain%2Fjava%2F.../raw?ref=bhtw"
```

## 全文搜索代码

```bash
glab api "projects/<project编码>/search?scope=blobs&search=<关键字>"
# 输出是 JSON，用 python3 提取 path
```

## 回写

```bash
# 整体注记（推荐用 create 子命令；--message 已废弃但 glab mr note 仍兼容）
glab mr note create <iid> -R <project> --message "$(cat /tmp/review.md)"

# 行内评论（挂到具体代码行）
glab mr create-comment <iid> -R <project> --line 123 --file <path> --message "..."
glab mr create-comment --help    # 查看行内参数

# 批准 / 改状态
glab mr approve <iid> -R <project>
glab mr update <iid> -R <project> --ready
```

## 常用 API（替代命令）

```bash
glab api "projects/<编码>/merge_requests/<iid>"                    # MR 详情 JSON
glab api "projects/<编码>/merge_requests/<iid>/changes"            # 结构化变更（含新旧文件路径）
glab api "projects/<编码>/merge_requests/<iid>/commits"            # commit 列表
```

## 安全

- 不要要求用户把 PAT 粘贴到对话里；建议用 `! glab auth login ... --token <PAT>` 由用户在终端执行，token 不进对话。
- 评审回写会以登录账号身份发布，先确认用户认可再发。
