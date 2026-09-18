#!/usr/bin/env bash
set -euo pipefail

# MUL-334：隔离 PPE 的标准 QA 登录引导。
#
# 为什么需要这一步：PPE 以无认证模式运行（MULTIREMI_TOKEN 未设置），服务端把任何
# 请求都当本地管理员放行，但 Web 前端是 token 模式——`AuthInitializer` 在
# localStorage 没有 `multimira_token` 时直接判未登录并跳 /login，根本不会去问
# /api/me。所以「PPE 免登录直接进业务页」从来不成立，真实页面验收必须先拿到一个
# token。
#
# 这里签发的是**该 PPE 自己**的短期本地 PAT：生产凭证全程不参与，
# MULTIREMI_QA_WEB_TOKEN 既不读取也不传递。占位字符串虽然能打开 HTTP 页面，但
# WebSocket 会持续 `invalid token` 重连，所以不作为正式验收登录态。
#
# 用法：
#   ppe-qa-session.sh login  <issue-key> <ppe-url> [target-path]
#   ppe-qa-session.sh logout <issue-key>
#   ppe-qa-session.sh status <issue-key>
#
# login 成功后照常用 `qa-browser-ssh.sh run-empty <issue-key> ...` 继续验收；
# 收尾必须调用 logout，它会撤销 PAT 并清理该 Issue 的浏览器上下文。

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
qa_browser_ssh="${here}/qa-browser-ssh.sh"
state_root="${MULTIREMI_PPE_QA_STATE_DIR:-${TMPDIR:-/tmp}/multiremi-ppe-qa}"
# 单次 HTTP 的上限。PPE 已经释放或网络黑洞时，curl 会一直挂到超时；收尾阶段不该
# 为一个已经没用的环境干等，测试也需要能把它调小。
http_timeout="${MULTIREMI_PPE_QA_HTTP_TIMEOUT:-15}"

# 只接受工作流分配的六个 PPE slot。生产 Origin 落不进来，误把生产地址传进来会硬失败。
readonly PPE_URL_RE='^(http://(10\.37\.117\.209|n37-117-209\.byted\.org):3210[1-6])(/.*)?$'

die() { echo "$*" >&2; exit 2; }

validate_issue_key() {
  [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] ||
    die "invalid issue key: use 1-80 letters, digits, dots, underscores, or dashes"
}

state_file() { printf '%s/%s.state\n' "${state_root}" "$1"; }

# 解析并校验 PPE URL，回显 origin。
ppe_origin() {
  local url="${1:-}"
  [[ "${url}" =~ ${PPE_URL_RE} ]] ||
    die "refusing a non-PPE URL: ${url:-<empty>} (expected http://{10.37.117.209|n37-117-209.byted.org}:32101-32106)"
  printf '%s\n' "${BASH_REMATCH[1]}"
}

# PPE 必须确实处于无认证模式，否则说明目标不是我们以为的隔离环境，直接停手，
# 不要在一个带认证的环境里乱签 token。
assert_open_mode() {
  local origin="$1" code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "${http_timeout}" "${origin}/api/me" || true)"
  [[ "${code}" == "200" ]] ||
    die "refusing to mint: ${origin}/api/me returned ${code:-<none>}, this is not an open-mode PPE"
}

cmd_login() {
  local issue_key="$1" url="$2" target_path="${3:-/}"
  validate_issue_key "${issue_key}"
  local origin
  origin="$(ppe_origin "${url}")"

  # 先把不花钱的本地检查做完再碰网络：否则 PPE 不可达时，真正的原因（比如上一轮
  # 会话没 logout）会被 curl 超时盖掉。
  [[ -x "${qa_browser_ssh}" || -r "${qa_browser_ssh}" ]] ||
    die "missing ${qa_browser_ssh}"

  install -d -m 700 "${state_root}"
  local state
  state="$(state_file "${issue_key}")"
  [[ -e "${state}" ]] &&
    die "a PPE QA session already exists for ${issue_key}; run logout first ($(cat "${state}" 2>/dev/null | tr '\n' ' '))"

  assert_open_mode "${origin}"

  local target_url="${origin}${target_path}"
  # token 只在这一条管道里存在：python 把明文写 stdout 直接进 ssh 标准输入，
  # token id 由同一个进程写进 0600 状态文件。它不进 shell 变量、不进 argv、不进日志。
  set +e
  MULTIREMI_PPE_QA_ORIGIN="${origin}" \
  MULTIREMI_PPE_QA_STATE="${state}" \
  MULTIREMI_PPE_QA_LABEL="${issue_key} desktop QA (MUL-334)" \
    env -u MULTIREMI_QA_WEB_TOKEN python3 "${here}/ppe-qa-mint.py" |
      env -u MULTIREMI_QA_WEB_TOKEN bash "${qa_browser_ssh}" \
        ppe-authenticate "${issue_key}" "${target_url}"
  local -a rc=("${PIPESTATUS[@]}")
  set -e

  if ((rc[0] != 0)); then
    rm -f -- "${state}"
    die "failed to mint a local PAT on ${origin}"
  fi
  if ((rc[1] != 0)); then
    # 签发成功但注入失败：token 已经存在于 PPE 上，必须立刻撤销，不能留着过期。
    echo "browser injection failed; revoking the freshly minted PAT" >&2
    cmd_logout "${issue_key}" || true
    die "failed to install the PPE QA session for ${issue_key}"
  fi

  printf 'PPE QA session ready: %s -> %s (token id %s)\n' \
    "${issue_key}" "${target_url}" "$(sed -n '2p' "${state}")"
}

cmd_logout() {
  local issue_key="$1"
  validate_issue_key "${issue_key}"
  local state
  state="$(state_file "${issue_key}")"

  local revoke_failed=0 origin="" token_id=""
  if [[ -r "${state}" ]]; then
    origin="$(sed -n '1p' "${state}")"
    token_id="$(sed -n '2p' "${state}")"
  fi

  if [[ -n "${origin}" && -n "${token_id}" ]]; then
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "${http_timeout}" \
      -X DELETE "${origin}/api/tokens/${token_id}" || true)"
    # 204 = 已撤销；404 = PPE 已经释放或 token 早就没了，同样算收干净。
    if [[ "${code}" == "204" || "${code}" == "404" ]]; then
      rm -f -- "${state}"
    else
      revoke_failed=1
      echo "WARNING: failed to revoke the PPE PAT (HTTP ${code:-<none>})." >&2
      echo "  origin=${origin} token_id=${token_id}" >&2
      echo "  retry: curl -X DELETE ${origin}/api/tokens/${token_id}" >&2
      echo "  若该 PPE 已释放则凭证随环境一起销毁，可忽略；否则必须手工撤销。" >&2
    fi
  fi

  # 浏览器上下文无论撤销成功与否都要清掉，别把登录态留在 212 上。
  bash "${qa_browser_ssh}" close "${issue_key}" >/dev/null 2>&1 || true
  bash "${qa_browser_ssh}" cleanup "${issue_key}" >/dev/null 2>&1 || true

  ((revoke_failed == 0)) || exit 1
  echo "PPE QA session closed for ${issue_key}"
}

cmd_status() {
  local issue_key="$1"
  validate_issue_key "${issue_key}"
  local state
  state="$(state_file "${issue_key}")"
  if [[ -r "${state}" ]]; then
    printf 'active: origin=%s token_id=%s\n' "$(sed -n '1p' "${state}")" "$(sed -n '2p' "${state}")"
  else
    echo "no active PPE QA session for ${issue_key}"
  fi
}

case "${1:-}" in
  login)
    [[ $# -ge 3 ]] || die "usage: ppe-qa-session.sh login <issue-key> <ppe-url> [target-path]"
    cmd_login "$2" "$3" "${4:-/}"
    ;;
  logout)
    [[ $# -ge 2 ]] || die "usage: ppe-qa-session.sh logout <issue-key>"
    cmd_logout "$2"
    ;;
  status)
    [[ $# -ge 2 ]] || die "usage: ppe-qa-session.sh status <issue-key>"
    cmd_status "$2"
    ;;
  *)
    die "usage: ppe-qa-session.sh login <issue-key> <ppe-url> [target-path] | logout <issue-key> | status <issue-key>"
    ;;
esac
