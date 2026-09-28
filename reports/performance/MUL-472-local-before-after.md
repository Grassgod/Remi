# MUL-472 本地首屏请求前后对比（schema 3）

**口径**：`tests/manual/mul384-perf-harness.ts`（内存 SQLite + 同一套 fixture：短单 / 长单 / running 单 / 深链 inbox 行），同机 `n37-066-008`，同 viewport `1440x900`，`--selectors auto`，`--warmup`（本地 `next dev` 的编译让步），每场景 3 轮（冷/热同口径）。前后两份报告见同目录的 `MUL-472-local-before-*.json`（issues / inbox / detail 各一份） 与 `MUL-472-local-after-*.json`。

**基线** = `origin/main` 的 `593ff2ba`（本单分支的 merge-base），在独立 worktree 里 checkout 后原生跑；**改动后** = 本单分支。两边都没有访问 209。

## 结论

- **三条被测路径的首屏请求数都下降，没有一条增加**：issues 27 → 22（−5）、inbox 19 → 15（−4）、detail-short 36 → 35（−1）。
- **列表页首次被 `--selectors auto` 判为 `contract`**：之前两条列表路径是 `legacy`，现在都有 `data-perf-scroll="list"` 标记（issues、inbox 都是 `contract`）。detail 两边本来就是 `contract`。
- **串行深度下降**：issues 10 → 9、inbox 11 → 9、detail-short 20 → 18。
- 冷启动 ready 时间在噪声范围内（issues p50 2680 → 2748ms、inbox 2546 → 2518ms、detail 3518 → 3425ms），本单目标是请求数与串行深度，不是 ready 毫秒。热切页在本地 fixture 上本就是 0～1 个请求，组内无差异。

## 逐请求消失清单（第 2 轮，cold）

| 页面 | 请求数 before → after | 消失的 path（before 首屏有、after 没有） | 新增 |
| --- | --- | --- | --- |
| issues | 27 → 22 | `/api/cli/latest-version`、`/api/inbox/summary`、`/api/issues/child-progress`、`/api/issues` ×2（workbench 徽标两次 `status=...&limit=200` 合并成一次 `statuses=` 并延后到 ready 之后） | 无 |
| inbox | 19 → 15 | `/api/cli/latest-version`、`/api/pins`、`/api/issues` ×2（同上，workbench 徽标两次合成一次） | 无 |
| detail-short | 36 → 35 | `/api/issues`（同上 workbench 徽标） | 无 |

issues / inbox 的 `/api/pins`、`/api/cli/latest-version`、`/api/inbox/summary`、`/api/squads`、`/api/agent-task-snapshot`、`/api/issues/child-progress` 在 after 里仍会出现，但**落在 ready 之后**（第 10～18 波），不计入首屏集合——正是 A5 接受的「最多晚 1s 出现」。detail 的 `/api/issues/:id` 系列归 MUL-403，本单不碰。

## 第 5 项标记的可见证据

after 报告里 `page-issues`、`page-inbox` 两行 `selectorMode` 字段是 `contract`（before 是 `legacy`），说明脚本按 `[data-perf-scroll]` 选中了新标记；标记本身由 `useListPerfMarker` 在该页自己那条列表请求 `status === "success"` 且不是 `keepPreviousData` 时写上。

## 复现命令

```bash
# 基线（独立 worktree，不要在主工作区切分支）
cd <worktree> && MUL384_NAME=MUL-472-local-before MUL384_ROUNDS=3 \
  MUL384_ONLY=page-issues bun run tests/manual/mul384-perf-harness.ts

# 改动后
cd <MUL-472 worktree> && MUL384_NAME=MUL-472-local-after MUL384_ROUNDS=3 \
  MUL384_ONLY=page-issues bun run tests/manual/mul384-perf-harness.ts
```

`MUL384_ONLY` 取 `page-issues` / `page-inbox` / `detail-short`；三份产物（json/md/html）一起写出。报告里 0 个 token 泄漏（harness 自带 grep 自检）。
