# 成员、权限与接入

## 当前用户与工作区成员

```sh
remi context --json
remi member get me --json
remi member list --json
remi member update me --name "<requested-name>" --json
remi member get me --json
```

`me` 指当前认证用户。工作区成员记录 ID 与其 `user_id` 不可混用；按命令需要解析成员，不能以显示名称、Agent ID 或另一个工作区的 member ID 代替用户身份。选择 `--workspace` 不会增加成员权限。

改角色前读回目标成员和当前用户角色；`member update --role` 支持 `owner|admin|member`，是否允许由服务器决定。移出或移入工作区、移除成员可能影响资源访问，不是简单改显示资料。

## 邀请与 token

```sh
remi invite list --json
remi invite create --email <invitee-email> --role member --json
remi invite get <invite-id> --json
remi token list --json
remi token create --help
remi token renew --help
remi token delete --help
```

用户要求邀请时，核对邮箱、工作区和 `admin|member` 角色后创建；邀请建立不代表对方已接受。`invite accept` / `decline` 由当前被邀请身份操作，`revoke` 撤回已有邀请；这些参数从各自帮助核对。

token create 支持 `--name`、`--purpose personal|cli`、`--expires-in-days`。新建或续期可能返回完整凭据：在工具外的受限进程中捕获并保存，输出只保留 ID、用途、到期时间与保存位置，不能直接把 JSON 打到对话。`token renew` 续期的是**当前 token**，没有任意 token ID 位置参数。先验证依赖它的客户端使用新凭据，再按用户要求撤销旧 token。

个人 token、CLI 登录会话和 daemon 安装凭据各有作用域；不能用个人 token 伪造 daemon，也不能为了配置任务把机器凭据提升为人类身份。

## 引导与账号配置

`member onboarding update/complete` 修改接入引导状态；`runtime-bootstrap`、`no-runtime-bootstrap` 和 `cloud-waitlist` 含实际资源或引导副作用，先查对应帮助及当前状态，避免重复初始化。

账号密码登录见 [连接](connection.md)。部署管理员的 `context auth password-account set` 使用部署 master token，可创建或重置账号并授予目标工作区 owner 成员资格；它不是普通登录失败时的恢复命令。只在用户要求账号管理且持有相应权限时使用，JSON 中工作区字段为 `workspaceId`。
