#!/usr/bin/env python3
"""MUL-334：在隔离 PPE 上签发一枚短期本地 PAT。

明文 token 只写 stdout（调用方直接接进 ssh 标准输入），token id 写进 0600 状态
文件。两者都不落到 argv、日志或仓库里。只由 ppe-qa-session.sh 调用。
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# 与 ppe-qa-session.sh 保持一致：只对 PPE slot 生效。这里再校验一次，避免有人
# 绕过 shell 直接调这个脚本去别的 Origin 签 token。
PPE_HOSTS = ("10.37.117.209", "n37-117-209.byted.org")
PPE_PORTS = tuple(str(p) for p in range(32101, 32107))

EXPIRES_IN_DAYS = 1


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(message, file=sys.stderr)
    raise SystemExit(2)


def check_origin(origin: str) -> None:
    prefix = "http://"
    if not origin.startswith(prefix):
        fail(f"refusing a non-PPE origin: {origin}")
    host, _, port = origin[len(prefix):].partition(":")
    if host not in PPE_HOSTS or port not in PPE_PORTS:
        fail(f"refusing a non-PPE origin: {origin}")


def main() -> None:
    origin = os.environ.get("MULTIREMI_PPE_QA_ORIGIN", "")
    state_path = os.environ.get("MULTIREMI_PPE_QA_STATE", "")
    label = os.environ.get("MULTIREMI_PPE_QA_LABEL", "PPE desktop QA")
    if not origin or not state_path:
        fail("MULTIREMI_PPE_QA_ORIGIN and MULTIREMI_PPE_QA_STATE are required")
    check_origin(origin)

    payload = json.dumps(
        {
            "name": label,
            "type": "pat",
            "purpose": "cli",
            "workspaceId": "local",
            "expiresInDays": EXPIRES_IN_DAYS,
        }
    ).encode()
    request = urllib.request.Request(
        f"{origin}/api/tokens",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        fail(f"PPE refused to mint a local PAT: HTTP {error.code}")
    except urllib.error.URLError as error:
        fail(f"cannot reach {origin}: {error.reason}")

    token = body.get("token")
    token_id = body.get("id")
    if not token or not token_id:
        # 拿不到明文就说明这个环境不是我们以为的无认证 PPE，或者接口语义变了。
        fail("PPE response carried no usable token; refusing to continue")

    # 状态文件只留 origin 和 token id —— id 不是凭证，撤销时要用它。
    fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(f"{origin}\n{token_id}\n{body.get('expires_at') or ''}\n")

    sys.stdout.write(token)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
