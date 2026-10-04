#!/usr/bin/env bash
set -euo pipefail

target_ip="${MULTIREMI_QA_DESKTOP_IP:-10.36.0.212}"
mesh_root="${MULTIREMI_SSH_MESH_ROOT:-${HOME}/.multiremi/ssh}"
remote_browser="/usr/local/bin/multiremi-qa-browser"

mapfile -t configs < <(find "${mesh_root}/workspaces" -mindepth 2 -maxdepth 2 -type f -name config -print 2>/dev/null | sort)
if ((${#configs[@]} == 0)); then
  echo "SSH Mesh configuration is missing under ${mesh_root}/workspaces" >&2
  exit 2
fi

# 每个别名都记下它所在的 workspace config，后面每次 ssh 都用 -F 显式加载它。
# OpenSSH 找用户配置用的是 passwd 里的 home，不看 $HOME：Agent 以 root 运行、
# HOME 却指向 /home/hehuajie 时，它去读 /root/.ssh/config，$HOME/.ssh/config 里
# 那条 Mesh Include 根本不生效，别名被当成主机名解析，212 明明好的却报不可达
# （MUL-497）。workspace config 自带 HostName / IdentityFile /
# StrictHostKeyChecking yes / Mesh 自己的 UserKnownHostsFile，单独加载就够，
# host-key 校验不会因此放松。
aliases=()
alias_configs=()
for config in "${configs[@]}"; do
  alias_name="$(awk -v target="${target_ip}" '
    $1 == "Host" { candidate = $2 }
    $1 == "HostName" && $2 == target { print candidate; exit }
  ' "${config}")"
  if [[ -n "${alias_name}" ]]; then
    aliases+=("${alias_name}")
    alias_configs+=("${config}")
  fi
done

if ((${#aliases[@]} == 0)); then
  echo "SSH Mesh has no managed alias for ${target_ip}" >&2
  exit 2
fi

selected=""
selected_config=""
# 探针必须始终 -n。authenticate / ppe-authenticate 是把凭证从管道喂进来的，
# 而 ssh 会把本地 stdin 转发给远端命令——探针那句 `test -x` 根本不读它，却会
# 在转发过程中把管道抽干，凭证于是永远到不了最后那次 exec。这里原来只在
# `check` 模式加 -n，生产 authenticate 一直靠「探针先退出」的竞态侥幸通过，
# PPE 链路则稳定复现为 `missing or invalid PPE token on stdin`（MUL-334）。
# 末尾的 exec 是另一次独立 ssh 调用，照常继承调用方 stdin，不受这里影响。
for i in "${!aliases[@]}"; do
  if ssh -F "${alias_configs[i]}" -n -o BatchMode=yes -o ConnectTimeout=5 \
    "${aliases[i]}" test -x "${remote_browser}" 2>/dev/null; then
    selected="${aliases[i]}"
    selected_config="${alias_configs[i]}"
    break
  fi
done

if [[ -z "${selected}" ]]; then
  echo "SSH Mesh cannot reach the QA browser host ${target_ip}" >&2
  exit 2
fi

if [[ "${1:-}" == "check" ]]; then
  printf 'QA browser ready via %s\n' "${selected}"
  exit 0
fi

if (($# == 0)); then
  echo "usage: qa-browser-ssh.sh check | <multiremi-qa-browser arguments...>" >&2
  exit 2
fi

printf -v remote_command '%q ' "${remote_browser}" "$@"
exec ssh -F "${selected_config}" -o BatchMode=yes -o ConnectTimeout=5 "${selected}" "${remote_command}"