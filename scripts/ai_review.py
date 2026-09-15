#!/usr/bin/env python3
"""GitLab MR AI review via glab + OpenAI-compatible API.

Usage:
  python3 scripts/ai_review.py                 # auto-detect MR for current branch
  python3 scripts/ai_review.py --mr 123
  python3 scripts/ai_review.py --dry-run       # print review, do not post
  python3 scripts/ai_review.py --limit 30      # max inline comments
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MARKER = "<!-- ai-mr-review -->"
SKIP_PATH_RE = re.compile(
    r"("
    r"package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|"
    r"go\.sum|composer\.lock|Gemfile\.lock|"
    r"dist/|build/|vendor/|node_modules/|\.min\.(js|css)|"
    r"\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|wav)$"
    r")",
    re.I,
)
MAX_DIFF_BYTES = int(os.environ.get("AI_REVIEW_MAX_DIFF_BYTES", "80000"))
MAX_FILE_DIFF_BYTES = int(os.environ.get("AI_REVIEW_MAX_FILE_DIFF", "12000"))
MAX_ISSUES_DEFAULT = int(os.environ.get("AI_REVIEW_MAX_ISSUES", "20"))

SYSTEM_PROMPT = """你是资深代码评审员，负责 GitLab Merge Request 评审。
只基于给出的 diff 与上下文判断，不要臆造文件外事实。

评审重点：
1. 正确性 / 边界 / 空指针 / 并发
2. 安全（注入、鉴权、敏感信息、不安全反序列化）
3. 可读性与可维护性（命名、重复、过深嵌套）
4. 性能上明显的问题
5. 与变更意图明显不符的实现

输出必须是严格 JSON（不要 markdown 代码块外的任何文字）：
{
  "summary": "2-5 句总体评价，中文",
  "verdict": "approve | comment | request_changes",
  "score": 0-10,
  "positives": ["做得好的点"],
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "相对路径",
      "line": 123,
      "side": "new|old",
      "title": "一句话标题",
      "body": "问题说明 + 可执行修改建议，中文"
    }
  ]
}

约束：
- issues 最多 {max_issues} 条，优先 high/medium
- line 必须是 diff 中实际出现的行号；不确定就放进 summary，不要乱挂行
- side: 表示新增行用 new，删除/旧文件行用 old
- 没有问题就返回空 issues，verdict=approve
- 不要输出无关闲聊
"""


# ---------------------------------------------------------------------------
# Shell / glab helpers
# ---------------------------------------------------------------------------


def run(cmd: List[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def glab_json(args: List[str]) -> Any:
    """Run glab with JSON output when supported, else parse stdout as JSON."""
    proc = run(["glab"] + args)
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"glab returned empty output: {' '.join(args)}\n{proc.stderr}")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        # some older glab versions print non-json for some subcommands
        raise RuntimeError(f"glab output is not JSON: {' '.join(args)}\n{out[:500]}")


def glab_raw(args: List[str]) -> str:
    proc = run(["glab"] + args)
    return proc.stdout


def ensure_glab_auth() -> None:
    proc = run(["glab", "auth", "status"], check=False)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit(
            "glab 未登录。本地请先执行:\n"
            "  glab auth login --hostname <your-gitlab-host>\n"
            "CI 中请设置 GITLAB_TOKEN / GITLAB_HOST 环境变量。\n"
        )


def resolve_host() -> str:
    host = os.environ.get("CI_SERVER_HOST") or os.environ.get("GITLAB_HOST") or ""
    if host:
        return host
    # fall back to first configured host from glab
    proc = run(["glab", "auth", "status"], check=False)
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line and not line.startswith("x") and " " not in line and "." in line:
            return line
    return "gitlab.com"


# ---------------------------------------------------------------------------
# MR resolution & diff
# ---------------------------------------------------------------------------


@dataclass
class MRInfo:
    project_path: str
    project_id: str
    iid: int
    title: str
    description: str
    source_branch: str
    target_branch: str
    web_url: str
    base_sha: str
    head_sha: str
    start_sha: str
    changes: List[Dict[str, Any]] = field(default_factory=list)


def resolve_mr(mr_arg: Optional[str]) -> MRInfo:
    project = os.environ.get("CI_MERGE_REQUEST_PROJECT_PATH") or os.environ.get(
        "CI_PROJECT_PATH"
    )
    if not project:
        # try current directory remote
        proc = run(["glab", "repo", "view", "-F", "json"], check=False)
        if proc.returncode == 0:
            try:
                repo = json.loads(proc.stdout)
                project = repo.get("pathWithNamespace") or repo.get("full_path")
            except json.JSONDecodeError:
                project = None
    if not project:
        raise SystemExit(
            "无法确定 GitLab 项目。请在仓库目录内运行，或设置 CI_PROJECT_PATH / CI_MERGE_REQUEST_PROJECT_PATH。"
        )

    iid: Optional[int] = None
    if mr_arg:
        iid = int(mr_arg.lstrip("!"))
    elif os.environ.get("CI_MERGE_REQUEST_IID"):
        iid = int(os.environ["CI_MERGE_REQUEST_IID"])
    else:
        # find open MR for current branch
        proc = run(["glab", "mr", "list", "--source-branch", _current_branch(), "-F", "json"], check=False)
        if proc.returncode == 0 and proc.stdout.strip():
            try:
                items = json.loads(proc.stdout)
            except json.JSONDecodeError:
                items = []
            if items:
                iid = int(items[0]["iid"])
    if iid is None:
        raise SystemExit("找不到当前分支对应的 open MR。可用 --mr <iid> 指定。")

    # Prefer REST via glab api for stable field names
    mr = glab_json(["api", f"projects/{_url_encode(project)}/merge_requests/{iid}"])
    changes_payload = glab_json(
        [
            "api",
            f"projects/{_url_encode(project)}/merge_requests/{iid}/changes",
        ]
    )
    diff_refs = mr.get("diff_refs") or changes_payload.get("diff_refs") or {}
    return MRInfo(
        project_path=project,
        project_id=str(mr.get("project_id") or _project_id(project)),
        iid=iid,
        title=mr.get("title") or "",
        description=(mr.get("description") or "")[:2000],
        source_branch=mr.get("source_branch") or "",
        target_branch=mr.get("target_branch") or "",
        web_url=mr.get("web_url") or "",
        base_sha=diff_refs.get("base_sha") or "",
        head_sha=diff_refs.get("head_sha") or "",
        start_sha=diff_refs.get("start_sha") or "",
        changes=changes_payload.get("changes") or [],
    )


def _current_branch() -> str:
    proc = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], check=False)
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def _url_encode(path: str) -> str:
    return path.replace("/", "%2F")


def _project_id(project_path: str) -> str:
    info = glab_json(["api", f"projects/{_url_encode(project_path)}"])
    return str(info["id"])


def filter_changes(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    kept = []
    for ch in changes:
        path = ch.get("new_path") or ch.get("old_path") or ""
        if not path or SKIP_PATH_RE.search(path):
            continue
        diff = ch.get("diff") or ""
        if not diff.strip():
            continue
        if ch.get("deleted_file") and not ch.get("renamed_file"):
            # still review deletions lightly — keep but truncate harder
            pass
        kept.append(ch)
    return kept


def build_diff_payload(mr: MRInfo) -> Tuple[str, List[Dict[str, Any]]]:
    """Return (prompt_diff_text, usable_changes)."""
    parts: List[str] = []
    used: List[Dict[str, Any]] = []
    total = 0
    for ch in filter_changes(mr.changes):
        path = ch.get("new_path") or ch.get("old_path")
        diff = (ch.get("diff") or "")[:MAX_FILE_DIFF_BYTES]
        block = f"### FILE: {path}\n{diff}\n"
        if total + len(block) > MAX_DIFF_BYTES and used:
            parts.append(f"\n…（其余 {len(mr.changes) - len(used)} 个文件因体积截断）\n")
            break
        parts.append(block)
        used.append(ch)
        total += len(block)
    return "".join(parts), used


# ---------------------------------------------------------------------------
# OpenAI-compatible client
# ---------------------------------------------------------------------------


def chat_complete(system: str, user: str) -> str:
    base = os.environ.get("AI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    key = os.environ.get("AI_API_KEY") or os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("AI_MODEL", "gpt-4o-mini")
    temperature = float(os.environ.get("AI_TEMPERATURE", "0.2"))
    timeout = float(os.environ.get("AI_TIMEOUT", "120"))

    if not key:
        raise SystemExit("缺少 AI_API_KEY（或 OPENAI_API_KEY）环境变量。")

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
    }
    # best-effort JSON mode; ignore if provider rejects
    if os.environ.get("AI_JSON_MODE", "1") not in ("0", "false", "False"):
        body["response_format"] = {"type": "json_object"}

    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        # retry once without response_format for picky providers
        if e.code == 400 and "response_format" in body:
            body.pop("response_format", None)
            req = urllib.request.Request(
                f"{base}/chat/completions",
                data=json.dumps(body).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {key}",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e2:
                raise SystemExit(f"AI API 调用失败 {e2.code}: {e2.read().decode('utf-8', 'replace')}")
        else:
            raise SystemExit(f"AI API 调用失败 {e.code}: {err}")
    except urllib.error.URLError as e:
        raise SystemExit(f"AI API 网络错误: {e}")

    try:
        return payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise SystemExit(f"AI 响应结构异常: {json.dumps(payload)[:500]}")


def parse_review_json(text: str) -> Dict[str, Any]:
    text = text.strip()
    # strip accidental markdown fence
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("review JSON must be an object")
    data.setdefault("summary", "")
    data.setdefault("verdict", "comment")
    data.setdefault("score", 5)
    data.setdefault("positives", [])
    data.setdefault("issues", [])
    if not isinstance(data["issues"], list):
        data["issues"] = []
    return data


# ---------------------------------------------------------------------------
# Post comments
# ---------------------------------------------------------------------------


def find_existing_marker_discussion(mr: MRInfo) -> Optional[str]:
    """Return discussion id if this bot already posted a summary marker."""
    try:
        discussions = glab_json(
            [
                "api",
                f"projects/{_url_encode(mr.project_path)}/merge_requests/{mr.iid}/discussions?per_page=100",
            ]
        )
    except Exception:
        return None
    for d in discussions or []:
        for note in d.get("notes") or []:
            if MARKER in (note.get("body") or ""):
                return d.get("id")
    return None


def post_summary(mr: MRInfo, review: Dict[str, Any], update_discussion_id: Optional[str]) -> None:
    positives = review.get("positives") or []
    issues = review.get("issues") or []
    verdict = review.get("verdict", "comment")
    score = review.get("score", "?")

    lines = [
        MARKER,
        f"## AI Code Review · {verdict} · {score}/10",
        "",
        review.get("summary") or "（无总体评价）",
        "",
    ]
    if positives:
        lines.append("**亮点**")
        for p in positives[:8]:
            lines.append(f"- {p}")
        lines.append("")
    if issues:
        lines.append("**问题摘要**")
        for i, iss in enumerate(issues[:30], 1):
            sev = iss.get("severity", "medium")
            loc = iss.get("file") or ""
            if iss.get("line"):
                loc = f"{loc}:{iss['line']}"
            lines.append(f"{i}. [{sev}] {iss.get('title', 'issue')} — `{loc}`")
        lines.append("")
        lines.append("详细见行内评论（若有）。")
    else:
        lines.append("未发现需要阻塞合并的问题。")

    body = "\n".join(lines)
    if update_discussion_id:
        # update first note of existing discussion
        try:
            notes = glab_json(
                [
                    "api",
                    f"projects/{_url_encode(mr.project_path)}/merge_requests/{mr.iid}/discussions/{update_discussion_id}",
                ]
            )
            note_id = None
            for n in notes.get("notes") or []:
                if MARKER in (n.get("body") or ""):
                    note_id = n.get("id")
                    break
            if note_id:
                run(
                    [
                        "glab",
                        "api",
                        "--method",
                        "PUT",
                        f"projects/{_url_encode(mr.project_path)}/merge_requests/{mr.iid}/discussions/{update_discussion_id}/notes/{note_id}",
                        "-f",
                        f"body={body}",
                    ]
                )
                return
        except Exception:
            pass
    # create new note
    run(
        [
            "glab",
            "mr",
            "note",
            str(mr.iid),
            "-m",
            body,
            "-R",
            mr.project_path,
        ]
    )


def valid_line(diff: str, side: str, line: int) -> bool:
    """Check that `line` exists on the requested side of the unified diff."""
    if not line or line <= 0:
        return False
    old_ln = new_ln = 0
    for raw in diff.splitlines():
        if raw.startswith("+++") or raw.startswith("---"):
            continue
        if raw.startswith("@@"):
            m = re.search(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", raw)
            if not m:
                return False
            old_ln, new_ln = int(m.group(1)), int(m.group(2))
            continue
        if raw.startswith("+"):
            if side == "new" and new_ln == line:
                return True
            new_ln += 1
        elif raw.startswith("-"):
            if side == "old" and old_ln == line:
                return True
            old_ln += 1
        elif raw.startswith("\\"):
            continue
        else:
            # context
            if side == "new" and new_ln == line:
                return True
            if side == "old" and old_ln == line:
                return True
            old_ln += 1
            new_ln += 1
    return False


def post_inline(mr: MRInfo, issues: List[Dict[str, Any]], limit: int) -> int:
    if not mr.base_sha or not mr.head_sha or not mr.start_sha:
        sys.stderr.write("MR 缺少 diff_refs，跳过行内评论。\n")
        return 0

    changes_by_path = {
        (c.get("new_path") or c.get("old_path")): c for c in mr.changes
    }
    posted = 0
    for iss in issues:
        if posted >= limit:
            break
        path = iss.get("file")
        if not path or path not in changes_by_path:
            continue
        side = (iss.get("side") or "new").lower()
        if side not in ("new", "old"):
            side = "new"
        line = iss.get("line")
        diff = changes_by_path[path].get("diff") or ""
        if not valid_line(diff, side, int(line or 0)):
            continue

        body = (
            f"**[{iss.get('severity', 'medium')}] {iss.get('title', 'Issue')}**\n\n"
            f"{iss.get('body', '')}"
        )
        position = {
            "position_type": "text",
            "base_sha": mr.base_sha,
            "head_sha": mr.head_sha,
            "start_sha": mr.start_sha,
        }
        if side == "new":
            position["new_path"] = path
            position["new_line"] = int(line)
            if changes_by_path[path].get("renamed_file"):
                position["old_path"] = changes_by_path[path].get("old_path") or path
        else:
            position["old_path"] = path
            position["old_line"] = int(line)
            position["new_path"] = changes_by_path[path].get("new_path") or path

        payload = {
            "body": body,
            "position": position,
        }
        # glab api --input - is awkward; use raw HTTP via glab api -f nested is hard.
        # Use curl-like approach through glab api with --input JSON file? Simpler: write temp JSON.
        # glab supports: glab api projects/:id/merge_requests/:iid/discussions -f body=... 
        # Nested position needs raw input. Use subprocess with JSON via stdin if supported.
        ok = _post_discussion_json(mr, payload)
        if ok:
            posted += 1
    return posted


def _post_discussion_json(mr: MRInfo, payload: Dict[str, Any]) -> bool:
    # glab api --input <file> --method POST path
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        proc = run(
            [
                "glab",
                "api",
                "--method",
                "POST",
                f"projects/{_url_encode(mr.project_path)}/merge_requests/{mr.iid}/discussions",
                "--input",
                path,
            ],
            check=False,
        )
        if proc.returncode != 0:
            sys.stderr.write(f"行内评论失败: {proc.stderr or proc.stdout}\n")
            return False
        return True
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def build_user_prompt(mr: MRInfo, diff_text: str) -> str:
    max_issues = int(os.environ.get("AI_REVIEW_MAX_ISSUES", str(MAX_ISSUES_DEFAULT)))
    return f"""请评审以下 Merge Request。

## MR 元信息
- 标题: {mr.title}
- 分支: {mr.source_branch} → {mr.target_branch}
- 链接: {mr.web_url}

## MR 描述
{mr.description or "（空）"}

## Diff（可能已截断）
{diff_text}

请输出严格 JSON，issues 最多 {max_issues} 条。
"""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description="GitLab MR AI review (glab + OpenAI-compatible)")
    ap.add_argument("--mr", help="MR iid, e.g. 123")
    ap.add_argument("--dry-run", action="store_true", help="只打印评审结果，不回写 MR")
    ap.add_argument("--limit", type=int, default=MAX_ISSUES_DEFAULT, help="最多行内评论数")
    ap.add_argument("--no-inline", action="store_true", help="只发总结，不发行内评论")
    args = ap.parse_args()

    ensure_glab_auth()
    host = resolve_host()
    print(f"[ai-review] host={host}", file=sys.stderr)

    mr = resolve_mr(args.mr)
    print(
        f"[ai-review] MR !{mr.iid} {mr.source_branch}→{mr.target_branch} "
        f"changes={len(mr.changes)}",
        file=sys.stderr,
    )

    diff_text, used_changes = build_diff_payload(mr)
    if not diff_text.strip():
        print("[ai-review] 无可评审 diff（可能全是跳过文件），退出。", file=sys.stderr)
        return 0

    print(f"[ai-review] reviewing {len(used_changes)} files, diff_bytes={len(diff_text)}", file=sys.stderr)
    system = SYSTEM_PROMPT.format(max_issues=args.limit)
    raw = chat_complete(system, build_user_prompt(mr, diff_text))
    try:
        review = parse_review_json(raw)
    except Exception as e:
        sys.stderr.write(f"AI 输出无法解析为 JSON: {e}\n---\n{raw[:2000]}\n")
        return 2

    if args.dry_run:
        print(json.dumps(review, ensure_ascii=False, indent=2))
        return 0

    existing = find_existing_marker_discussion(mr)
    post_summary(mr, review, existing)
    inline_count = 0
    if not args.no_inline:
        inline_count = post_inline(mr, review.get("issues") or [], args.limit)
    print(
        f"[ai-review] done. summary={'updated' if existing else 'created'}, inline={inline_count}, "
        f"url={mr.web_url}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
