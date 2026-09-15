#!/usr/bin/env bash
# 本地手动触发 AI MR 评审
# 用法:
#   ./scripts/review-local.sh           # 自动找当前分支 MR
#   ./scripts/review-local.sh 123       # 指定 MR
#   ./scripts/review-local.sh --dry-run # 只看结果不回写
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# 确保 glab 已登录
if ! glab auth status >/dev/null 2>&1; then
  echo "glab 未登录。请先: glab auth login --hostname <你的 GitLab 域名>" >&2
  exit 1
fi

if [[ -z "${AI_API_KEY:-}${OPENAI_API_KEY:-}" ]]; then
  echo "缺少 AI_API_KEY，请写入 .env（参考 .env.example）" >&2
  exit 1
fi

exec python3 "$ROOT/scripts/ai_review.py" "$@"
