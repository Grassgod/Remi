import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const deployRoot = resolve(repoRoot, "deploy/zadig");
const versions = readFileSync(resolve(deployRoot, "versions.env"), "utf8");
const installer = readFileSync(resolve(deployRoot, "install.sh"), "utf8");
const edgeConfigurator = readFileSync(resolve(deployRoot, "configure-edge.sh"), "utf8");
const bootstrap = readFileSync(resolve(deployRoot, "bootstrap.sh"), "utf8");
const configurePpe = readFileSync(resolve(deployRoot, "configure-ppe.sh"), "utf8");
const verifier = readFileSync(resolve(deployRoot, "verify.sh"), "utf8");
const remover = readFileSync(resolve(deployRoot, "remove.sh"), "utf8");
const skill = readFileSync(resolve(deployRoot, "skill/multiremi-ppe-qa/SKILL.md"), "utf8");
const webQaSkill = readFileSync(resolve(deployRoot, "skill/multiremi-web-qa/SKILL.md"), "utf8");
const ppeSession = readFileSync(
  resolve(deployRoot, "skill/multiremi-web-qa/scripts/ppe-qa-session.sh"),
  "utf8",
);
const ppeMint = readFileSync(
  resolve(deployRoot, "skill/multiremi-web-qa/scripts/ppe-qa-mint.py"),
  "utf8",
);
const desktopWrapper = readFileSync(resolve(deployRoot, "desktop-qa/multiremi-qa-browser"), "utf8");
const workflow = readFileSync(resolve(deployRoot, "ppe/workflow.sh"), "utf8");
const collector = readFileSync(resolve(deployRoot, "ppe/gc.sh"), "utf8");
const dockerfileWeb = readFileSync(resolve(repoRoot, "deploy/docker/Dockerfile.web"), "utf8");
const nextConfig = readFileSync(resolve(repoRoot, "frontend/apps/web/next.config.ts"), "utf8");

describe("Zadig PPE deployment", () => {
  test("pins external dependencies and keeps data on /data00", () => {
    expect(versions).toMatch(/^K3S_VERSION="v[^"]+"$/mu);
    expect(versions).toMatch(/^K3S_INSTALL_SCRIPT_SHA256="[a-f0-9]{64}"$/mu);
    expect(versions).toMatch(/^HELM_VERSION="v[^"]+"$/mu);
    expect(versions).toMatch(/^HELM_TARBALL_SHA256="[a-f0-9]{64}"$/mu);
    expect(versions).toMatch(/^ZADIG_VERSION="[0-9]+\.[0-9]+\.[0-9]+"$/mu);
    expect(versions).toMatch(/^PPE_REGISTRY_IMAGE="[^"@]+:[^"@]+@sha256:[a-f0-9]{64}"$/mu);
    expect(versions).toMatch(/^PPE_KANIKO_IMAGE="[^"@]+:[^"@]+@sha256:[a-f0-9]{64}"$/mu);
    expect(versions).toContain('ZADIG_ROOT="/data00/multiremi/zadig"');
    expect(installer).toContain("sha256sum -c -");
    expect(installer).toContain("--data-dir ${ZADIG_ROOT}/k3s");
  });

  test("isolates k3s from production Docker networks and ports", () => {
    expect(versions).toContain('K3S_CLUSTER_CIDR="172.28.0.0/16"');
    expect(versions).toContain('K3S_SERVICE_CIDR="172.29.0.0/16"');
    expect(versions).toContain('ZADIG_NODE_PORT="32080"');
    expect(versions).toContain('ZADIG_PUBLIC_HOST="n37-117-209.byted.org"');
    expect(versions).toContain('ZADIG_PUBLIC_PORT="410"');
    expect(versions).toContain('PPE_REGISTRY_NODE_PORT="32050"');
    expect(installer).toContain("--disable traefik --disable servicelb");
    expect(installer).toContain("/etc/rancher/k3s/registries.yaml");
    expect(installer).toContain("PPE registry is ready");
    expect(installer).not.toContain("docker.sock");
    expect(installer).toContain('endpoint.type=FQDN');
    expect(installer).toContain('endpoint.FQDN=${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}');
    expect(installer).toContain('${SCRIPT_DIR}/configure-edge.sh');
    expect(edgeConfigurator).toContain('listen ${ZADIG_PUBLIC_PORT}');
    expect(edgeConfigurator).toContain('return 302 http://${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}/');
  });

  test("provides exactly six quota-backed PPE slots and concurrency three", () => {
    expect(versions).toContain('PPE_MAX_ENVIRONMENTS="6"');
    expect(versions).toContain('PPE_BUILD_CONCURRENCY="3"');
    expect(installer).toContain("kubectl create resourcequota multiremi-ppe-budget");
    expect(installer).toContain("kind: LimitRange");
    expect(installer).toContain('${SCRIPT_DIR}/bootstrap.sh');
    expect(bootstrap).toContain("/api/aslan/system/concurrency/workflow");
    expect(bootstrap).toContain("workflow_concurrency");
    expect(bootstrap).toContain("build_concurrency");
    expect(verifier).toContain("workflow_concurrency");
    expect(verifier).toContain("build_concurrency");
  });

  test("bootstraps credentials without committing or printing secrets", () => {
    const logCalls = bootstrap
      .split("\n")
      .filter((line) => /^\s*log\s/.test(line))
      .join("\n");
    expect(bootstrap).toContain('ADMIN_PASSWORD_FILE="${SECRETS_DIR}/admin-password"');
    expect(bootstrap).toContain('ADMIN_API_TOKEN_FILE="${SECRETS_DIR}/admin-api-token"');
    expect(bootstrap).toContain('QA_API_TOKEN_FILE="${SECRETS_DIR}/qa-api-token"');
    expect(bootstrap).toContain('ROTATE_ZADIG_QA_TOKEN:-0');
    expect(bootstrap).toContain('/api/v1/users/${qa_uid}/token');
    expect(bootstrap).toContain("chmod 0600");
    expect(logCalls).not.toMatch(/password/i);
    expect(logCalls).not.toMatch(/api.token/i);
  });

  test("creates an isolated QA identity and pins the official CLI", () => {
    expect(versions).toContain('ZADIG_QA_USERNAME="multiremi-qa"');
    expect(versions).toContain('ZADIG_CLI_PACKAGE="@koderover/zadig-cli@0.1.6"');
    expect(bootstrap).toContain("QA account is ready without system administrator authority");
    expect(skill).toContain("@koderover/zadig-cli@0.1.6");
    expect(skill).toContain("不得使用 `latest`");
    expect(skill).toContain('"${zadig_cli[@]}"');
  });

  test("supports platform and isolated daemon verification modes", () => {
    expect(skill).toContain("`platform`");
    expect(skill).toContain("`platform-daemon`");
    expect(skill).toContain("控制面与 daemon 使用同一目标 Commit");
    expect(skill).toContain("不复用生产 Runtime ID");
    expect(skill).toContain("不得调用生产 Platform Updater");
    expect(skill).toContain("PPE_ACTION=release");
    expect(configurePpe).toContain('WORKFLOW_KEY="multiremi-ppe-deploy"');
    expect(configurePpe).toContain("concurrency_limit:-1");
    expect(configurePpe).toContain('actions:["get_workflow","run_workflow"');
    expect(configurePpe).toContain("PPE_FAKE_ACP_BASE64");
    expect(workflow).toContain("NODE_ENV, value: development");
    expect(workflow).toContain("configMap: { name: ppe-fake-acp");
    expect(workflow).toContain("timeout 20s");
    expect(workflow).toContain("agent default --provider codex");
    expect(workflow).toContain("registry_manifest_exists");
    expect(workflow).toContain("Reusing API image for commit");
    expect(workflow).toContain("prepare-fake-codex-home");
    expect(workflow).toContain("wait-for-postgres");
    expect(workflow).toContain("wait-for-api");
    expect(workflow).toContain("ppe-fake-acp-only");
  });

  test("atomically leases PPEs per Issue and reclaims them after 24 hours", () => {
    expect(versions).toContain('PPE_TTL_HOURS="24"');
    expect(versions).toContain('PPE_GC_SCHEDULE="*/5 * * * *"');
    expect(configurePpe).toContain('choice_option:["auto","1","2","3","4","5","6"]');
    expect(configurePpe).toContain('name:"ISSUE_KEY"');
    expect(configurePpe).toContain('name:"PPE_LEASE_ID"');
    expect(workflow).toContain('create configmap "${lease_name}"');
    expect(workflow).toContain("acquire_allocation_lock");
    expect(workflow).toContain("PPE_ALLOCATION_LOCK_TTL_MINUTES");
    expect(workflow).toContain("find_issue_slot");
    expect(workflow).toContain("rollback_new_lease");
    expect(workflow).toContain("PPE_RESULT=");
    expect(workflow).toContain("PPE lease ID does not match");
    expect(installer).toContain("kind: CronJob");
    expect(installer).toContain("multiremi-ppe-gc-script");
    expect(collector).toContain("reclaiming expired");
    expect(collector).toContain('delete configmap "${lease_name}"');
    expect(verifier).toContain("PPE GC schedule");
    expect(remover).toContain("delete cronjob multiremi-ppe-gc");
  });

  test("sizes the Web image build so it cannot be OOM-killed (MUL-303)", () => {
    // Next sizes its worker pool from the host CPU count, so the build must be
    // told how many workers the container can actually afford.
    expect(dockerfileWeb).toContain("ARG NEXT_BUILD_CPUS");
    expect(dockerfileWeb).toContain("ENV NEXT_BUILD_CPUS=$NEXT_BUILD_CPUS");
    expect(nextConfig).toContain("NEXT_BUILD_CPUS");
    expect(nextConfig).toContain("{ cpus }");
    expect(workflow).toContain("NEXT_BUILD_CPUS=${PPE_WEB_BUILD_CPUS}");
    expect(workflow).toContain("PPE_WEB_BUILD_MEMORY");
    expect(workflow).toContain("memory: ${memory_limit}");
    expect(workflow).not.toContain("memory: 6Gi");
    // Both build Jobs plus the deployed stack have to fit the namespace quota.
    expect(installer).toContain("limits.memory=32Gi");
  });

  test("surfaces a failed build instead of waiting out the timeout (MUL-303)", () => {
    // kubectl wait --for=condition=complete never returns for a Failed Job.
    expect(workflow).not.toContain("wait --for=condition=complete");
    expect(workflow).toContain("build_job_condition");
    expect(workflow).toContain("Failed; then");
    expect(workflow).toContain("build_job_progress");
    expect(workflow).toContain("PPE_BUILD_TIMEOUT_SECONDS");
  });

  test("releases the slot lock on cancellation rather than after a fixed TTL (MUL-303)", () => {
    expect(versions).toContain('PPE_WORKFLOW_LOCK_TTL_MINUTES="10"');
    expect(workflow).toContain("start_lock_heartbeat");
    expect(workflow).toContain("stop_lock_heartbeat");
    expect(workflow).toContain("PPE_WORKFLOW_LOCK_HEARTBEAT_SECONDS");
    expect(workflow).toContain("workflow_lock_is_own_task");
    expect(workflow).toContain("abandon_failed_deploy");
    expect(workflow).toContain("trap 'exit 143' INT TERM");
    // The collector must reap stale locks even while the lease is still valid.
    expect(collector).toMatch(/Reap stale workflow locks before anything else/u);
    expect(collector.indexOf('lock_is_active "${namespace}" || true')).toBeLessThan(
      collector.indexOf("expires_epoch > now_epoch"),
    );
  });

  test("keeps PPE browser auth isolated from production", () => {
    expect(skill).toContain("PPE_SLOT=auto");
    expect(skill).toContain("PPE_RESULT.state=released");
    expect(skill).toContain("不得读取或传入生产\n   Web Token");
    expect(webQaSkill).toContain("3210[1-6]");
    expect(webQaSkill).toContain("其他地址全部按生产认证处理");
    // MUL-334：PPE 服务端无认证，但前端是 token 模式，空浏览器必被守卫弹回
    // /login。旧文案「PPE 模式直接进入目标页面，不读取 Token」是错的，两个
    // Skill 都不得再出现它，否则下一轮 QA 还会照着它撞上同一个阻塞。
    expect(webQaSkill).not.toContain("PPE 模式直接进入目标页面，不读取 Token");
    expect(webQaSkill).toContain("ppe-qa-session.sh login");
    expect(webQaSkill).toContain("该 PPE 自己签发");
    expect(skill).toContain("服务端无认证不等于浏览器可以免登录");
  });

  test("mints the PPE browser credential on the PPE itself and revokes it", () => {
    // 签发/撤销只针对 32101-32106 的 PPE slot，生产 Origin 落不进这条路径。
    expect(ppeSession).toContain("3210[1-6]");
    expect(ppeSession).toContain("refusing a non-PPE URL");
    expect(ppeMint).toContain('PPE_PORTS = tuple(str(p) for p in range(32101, 32107))');
    expect(ppeMint).toContain("refusing a non-PPE origin");

    // 目标必须确实处于无认证模式，否则不签。
    expect(ppeSession).toContain("this is not an open-mode PPE");

    // 生产凭证既不读取也不传递给子进程。
    expect(ppeSession).toContain("env -u MULTIREMI_QA_WEB_TOKEN");
    expect(ppeSession).not.toMatch(/\$\{?MULTIREMI_QA_WEB_TOKEN/u);

    // 明文 token 只走管道；状态文件只留 origin + token id。
    expect(ppeMint).toContain("sys.stdout.write(token)");
    expect(ppeMint).toContain("0o600");
    expect(ppeMint).not.toContain("handle.write(token");

    // 注入失败要立刻撤销，撤销失败要给出可恢复信息。
    expect(ppeSession).toContain("revoking the freshly minted PAT");
    expect(ppeSession).toContain("curl -X DELETE ${origin}/api/tokens/${token_id}");

    // 212 wrapper 的两条注入路径 Origin 白名单互不相交。
    expect(desktopWrapper).toContain("ppe-authenticate");
    expect(desktopWrapper).toContain("refusing to inject a token into a non-PPE origin");
    expect(desktopWrapper).toContain("refusing to inject a Multiremi PAT into an untrusted origin");
    expect(desktopWrapper).toMatch(
      /ppe_authenticate_browser[\s\S]*?\^\(http:\/\/\(10\\\.37\\\.117\\\.209\|n37-117-209\\\.byted\\\.org\):3210\[1-6\]\)/u,
    );
  });

  test("keeps removal explicit and production updates outside Zadig", () => {
    expect(remover).toContain('CONFIRM_REMOVE_ZADIG:-');
    expect(remover).toContain("remove-zadig-and-ppe");
    expect(skill).toContain("不得调用生产 Platform Updater");
    expect(skill).toContain("不要实现 Zadig 到\nMultiremi 的自动回写");
  });
});
