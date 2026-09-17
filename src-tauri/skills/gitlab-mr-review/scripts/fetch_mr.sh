#!/usr/bin/env bash
# 抓取 GitLab MR 评审所需全部素材：信息、全部评论、diff
# 用法: fetch_mr.sh <iid> <project> [output_dir]
# 示例: fetch_mr.sh 3256 agent/insuranceagent
# 注意: 自建实例需先 export GITLAB_HOST=<域名>
set -euo pipefail

IID="${1:?用法: fetch_mr.sh <iid> <project> [output_dir]}"
PROJECT="${2:?用法: fetch_mr.sh <iid> <project> [output_dir]}"
OUT="${3:-/tmp/glab_mr_${IID}}"

# project 路径编码: agent/insuranceagent -> agent%2Finsuranceagent
ENC="${PROJECT//\//%2F}"

mkdir -p "$OUT"

glab mr view "$IID" -R "$PROJECT" > "$OUT/info.txt" 2>&1
glab api "projects/${ENC}/merge_requests/${IID}/notes?per_page=100&sort=asc" > "$OUT/notes.json"
glab mr diff "$IID" -R "$PROJECT" > "$OUT/diff.diff"

echo "MR 信息: $OUT/info.txt"
echo "历史评论: $OUT/notes.json"
echo "diff: $OUT/diff.diff ($(wc -l < "$OUT/diff.diff") 行, $(grep -c '^+++ ' "$OUT/diff.diff") 个文件)"
