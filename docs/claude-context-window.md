# Claude Context Windows

Remi selects the Claude Code `[1m]` model variant for these known full IDs:

- `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`
- `claude-fable-5`, `claude-fable-5-1`
- `claude-sonnet-4-6`, `claude-sonnet-5`

This applies in the shared ACP execution path to new, resumed, and pooled
sessions. The stored Agent model is unchanged. Explicit `[1m]` selections are
passed through, including aliases such as `opus[1m]`. Unqualified aliases,
custom gateway IDs, older models, and non-Claude engines are not rewritten.
Their underlying model may not support 1M. Set
`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` to disable automatic selection; explicit
selections still go to Claude Code, which enforces its own configuration.

The startup wrapper requires Claude Code 2.1.259 or newer and checks the actual
executable, not the Agent SDK package version. Explicit
`REMI_CLAUDE_CODE_EXECUTABLE` / `CLAUDE_CODE_EXECUTABLE` paths take precedence.
Otherwise it checks the SDK's bundled executable (including hoisted installs),
then a compatible installed Claude CLI. An incompatible explicit path fails
with an upgrade instruction rather than silently selecting another runtime.
This change does not install or upgrade the machine's Claude CLI.

Claude ACP resolves full IDs to model-picker aliases. Remi forwards explicit
1M selections to that resolver even if the exact ID isn't a picker entry,
and does not prompt if the selection fails or returns a non-1M lane.

The card continues to use SDK `usage_update.used` / `usage_update.size`;
there is no 1M display override or database migration. Existing completed
cards are unchanged. Restart the daemon after changing the runtime binary;
resuming a session preserves its history and reapplies the configured model.

References:

- [Claude Code extended context](https://code.claude.com/docs/en/model-config#extended-context)
- [Pinned models and the 1M suffix](https://code.claude.com/docs/en/model-config#pin-models-for-third-party-deployments)
- [Fable runtime requirements](https://code.claude.com/docs/en/model-config#work-with-fable)
- [API context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-sizes-by-model)

The suffix configures Claude Code, which removes it before sending the model
ID to the provider. Native 1M models do not require a manually added API beta
header. This does not change the model's actual capacity.
