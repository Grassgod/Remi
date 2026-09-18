# 212 桌面 QA wrapper

`multiremi-qa-browser` 是 `10.36.0.212` 上真正执行浏览器验收的包装脚本，部署路径
`/usr/local/bin/multiremi-qa-browser`。在 MUL-334 之前它只存在于那台机器上、没有任何
版本控制，改一次就无从 review，所以这里把它入库作为权威副本。

## 同步方式

改动先落在本目录，再部署到 212：

```bash
# 备份 → 语法检查 → 原子替换
scp deploy/zadig/desktop-qa/multiremi-qa-browser <212>:/usr/local/bin/multiremi-qa-browser.new
ssh <212> 'cp -a /usr/local/bin/multiremi-qa-browser /usr/local/bin/multiremi-qa-browser.bak-<ISSUE> \
  && chmod 755 /usr/local/bin/multiremi-qa-browser.new \
  && bash -n /usr/local/bin/multiremi-qa-browser.new \
  && mv /usr/local/bin/multiremi-qa-browser.new /usr/local/bin/multiremi-qa-browser'
```

只能经受管 SSH Mesh 别名访问 212，不要裸连或复制私钥。部署后用 `sha256sum` 与本目录
副本比对确认一致。

## 子命令

| 命令 | 用途 |
| --- | --- |
| `prepare` / `run` | Aiden 等必须走人工 SSO 的目标，从只读源 Profile 复制 |
| `prepare-empty` / `run-empty` | 空 Profile，用于 Multiremi 生产与 PPE |
| `authenticate` | 生产 Multiremi：从 stdin 读 PAT 写入 `multimira_token`，Origin 白名单只有 `http://n37-117-209.byted.org` |
| `ppe-authenticate` | 隔离 PPE：同样从 stdin 读 token，Origin 白名单只有 `32101-32106` 两个主机名 |
| `close` / `cleanup` | 关闭并删除当前 Issue 的浏览器上下文 |

`authenticate` 与 `ppe-authenticate` 的 Origin 白名单互不相交：生产 PAT 进不了 PPE，
PPE 的本地 PAT 也进不了生产。两条路径都只接受 stdin 传入的凭证，绝不接受命令行参数。

## 为什么 PPE 也需要注入 token

PPE 不设 `MULTIREMI_TOKEN`，服务端确实把任何请求都当本地管理员放行。但 Web 前端是
token 模式：`AuthInitializer` 在 `localStorage` 没有 `multimira_token` 时直接判未登录
并跳 `/login`，根本不会去问 `/api/me`。MUL-334 在 212 上实测过三种情况——空上下文必被
拦回登录页；占位串能打开 HTTP 页面但 WebSocket 持续 `invalid token`；该 PPE 自己签发
的短期本地 PAT 才能让页面、API 和 WebSocket 全部正常。

签发与撤销由 `../skill/multiremi-web-qa/scripts/ppe-qa-session.sh` 负责。
