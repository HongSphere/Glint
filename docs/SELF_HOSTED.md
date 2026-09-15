# 自建 GitLab 接入清单

按顺序做完即可跑通。

## A. GitLab 侧

1. 确认实例域名可从 Runner 和你的开发机访问（例如 `gitlab.example.com`）。
2. 建 **Project Access Token**（或 Group Token）：
   - Role: `Developer` 起（要能写 note / discussion）
   - Scopes: 勾选 `api`
   - 记下 token，只放 CI Variable 或本地 `.env`，不要进 git
3. Settings → CI/CD → Variables 增加：

| Key | Masked | 说明 |
|-----|--------|------|
| `GITLAB_TOKEN` | ✓ | 上面的 access token |
| `AI_BASE_URL` | | 含 `/v1` 的 OpenAI 兼容地址 |
| `AI_API_KEY` | ✓ | 模型网关 key |
| `AI_MODEL` | | 如 `deepseek-chat` / `qwen-plus` / `gpt-4o-mini` |

## B. 本机

```bash
brew install glab
glab auth login --hostname gitlab.example.com
```

验证：

```bash
glab auth status
glab api user
```

## C. 业务仓库

拷贝本模板中的：

- `scripts/ai_review.py`
- `scripts/review-local.sh`
- `.gitlab-ci.yml`（若已有 CI，合并 job）
- `.env.example` → 本地改成 `.env`

本地验证（不回写）：

```bash
./scripts/review-local.sh --dry-run
```

真正回写：

```bash
./scripts/review-local.sh
```

## D. CI 触发

推一个 MR，流水线里应出现 `ai-mr-review` job。  
MR 页面应有一条带 `AI Code Review` 的总结贴，以及若干行内评论。

## 安全注意

- `.env` 加进 `.gitignore`
- CI Variable 务必 Masked；token 权限最小到 `api` + Developer
- 不要把内部代码 diff 发到不可信公网模型；内网请用公司网关并改 `AI_BASE_URL`
