# Antigravity (agy) Runtime

Remi supports Antigravity as the `antigravity` provider. It invokes the native `agy` CLI through [AntigravityProvider](../packages/acp/src/antigravity.ts); Claude and Codex continue to use ACP. The implementation follows the [official headless CLI contract](https://antigravity.google/docs/cli/headless/), with compatibility cases identified in Multica's `server/pkg/agent/antigravity.go` and model discovery at commit `ded103c8c44e3fec15b4c3a5d36d2b4bbf974d35`.

## Configure a machine

1. Install and sign in using the [official Windows, macOS or Linux instructions](https://antigravity.google/docs/cli/install). Authentication belongs to the daemon machine's native agy account; Remi does not initiate login or copy Claude/Codex credentials into agy.
2. Verify `agy --version` and `agy models` from the account that runs the daemon. A working executable does not prove the account is signed in.
3. Start the configured daemon with `remi daemon start --provider antigravity`, or let the daemon discover providers automatically. The provider name is `antigravity`; the executable name is `agy`.
4. Select Antigravity when creating or editing an Agent. Models come from the Runtime's `agy models` catalog. CLI equivalents are `remi agent create --provider antigravity ...` and `remi agent edit <id> --provider antigravity`.

| Environment variable | Purpose |
| --- | --- |
| `MULTIREMI_ANTIGRAVITY_PATH` | Path to the native agy executable; Agent `executable` overrides it for task execution |
| `MULTIREMI_ANTIGRAVITY_MODEL` | Default model if the Agent has no explicit model; must match a catalog ID |
| `MULTIREMI_ANTIGRAVITY_SKILLS_DIR` | Root for importing machine-local Skills; defaults to `~/.agents/skills` |

PATH discovery also checks the standard `~/.local/bin/agy` or Windows `%LOCALAPPDATA%/agy/bin/agy.exe` location. Install agy separately; Remi's ACP bridge provisioning does not install an ACP wrapper for it. Runtime Agent CLI updates invoke `agy update`; ACP bridge updates do not apply.

## Execution and compatibility

The provider inspects the installed CLI's help before choosing its protocol. Versions advertising streaming JSON emit text/tool events and actual token usage into the existing task transcript. When streaming input is available, prompts travel over stdin, preserving multiline content and avoiding Windows command-line length limits. Otherwise the one-shot `-p` interface is used.

Explicit conversation IDs drive Chat/Issue continuation; the adapter never resumes the machine's most recent conversation implicitly. Cancellation stops the task's process tree, including on Windows, while retaining any observed conversation ID for steering. A configured task deadline is enforced by the daemon; the CLI also receives an explicit print timeout so its five-minute default cannot silently truncate a longer task.

Older text-only releases preserve stdout line breaks, extract the conversation ID from the per-run log, and recover an empty stdout from the current turn of the CLI transcript. Log-only provider errors and print timeouts fail the task even when agy exits with code 0. Missing terminal JSON results and unrecoverable empty responses also fail. Legacy releases that report no usage leave token counts unknown.

Reasoning levels are exposed only when the installed CLI advertises `--effort`. Model IDs are discovered, not hard-coded; legacy one-column catalogs and newer tab-separated IDs/labels are accepted. An unavailable catalog does not fabricate models. A non-empty model absent from a successfully discovered catalog is rejected before execution.

## Context and supported boundaries

Task instructions, project context and Skills use Remi's existing bootstrap/delta prompts. Skills in automatic execution directories are materialized under `.agents/skills`. When bound to a Runtime directory, Remi stores its context and Skill files in daemon-owned state, passes a Skill index and the local instructions into the prompt, and keeps the selected user directory as the child cwd. Remi does not replace the user's `AGENTS.md` or write platform metadata into that directory.

The native agy OAuth profile and conversation history remain in agy's own data directory. Remi tracks the explicit conversation ID and owns its separate task context; its existing Claude/Codex isolated native-home contract does not apply to agy. A native agy login is required on each machine that executes it.

This integration supports automatic approval. It rejects Remi interactive approval requests, tool allowlists, non-text media, task-scoped MCP configuration and Remi Agent Plugins before starting a task, because the adapter cannot enforce those contracts. Configure machine-level MCP through `agy mcp` if needed. Claude/Codex Relay configuration remains scoped to those two providers.

## Validation

Run `bun test tests/unit/acp/antigravity.test.ts tests/integration/antigravity-daemon.test.ts`. The subprocess fixture covers the public CLI event formats and legacy failure/recovery cases. The integration test runs a real API and daemon through Chat creation, continuation, and Issue execution in a retained directory, using a simulated agy executable. It does not prove successful Google authentication or real model execution.

After native login, run a task through an Antigravity Runtime and verify its reply, resumed conversation, tool transcript, usage and selected cwd. Do not label a CLI version check or a simulated-provider test as a real-model smoke.
