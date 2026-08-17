/**
 * Multiremi CLI — `--help` text.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

export function showHelp(programName = "remi multiremi"): void {
  console.log(`
Usage: ${programName} <command> [options]

Commands:
  setup                  Save server/workspace/token config
  login                  Save a personal access token
  config                 Show or update saved config
  serve                  Start Bun Multiremi API server
  daemon                 Manage the local Bun Multiremi runtime daemon
  daemon start           Start daemon in the background
  daemon stop            Stop the background daemon
  daemon restart         Restart the background daemon
  daemon status          Show daemon health
  daemon logs            Show daemon logs
  daemon service         Install, uninstall, or print a user-level service
  repo checkout <url>    Check out an allowed workspace repository
  attachment download <id> Download an attachment to a local file
  agent list             List agents
  agent get <id>         Print an agent as JSON
  agent edit <id>        Edit agent identity and runtime metadata
  agent update <id>      Alias for agent edit
  issue get <id>         Print an issue as JSON
  issue list             List issues
  issue create           Create an issue
  issue update <id>      Update an issue
  issue assign <id>      Assign or unassign an issue
  issue status <id> <s>  Change issue status
  issue delete <id>      Delete an issue
  issue search <query>   Search issues
  issue comment list <id> List issue comments
  issue comment add <id> Add an issue comment
  issue comment update <comment-id>
  issue comment delete <comment-id>
  issue comment resolve <comment-id>
  issue session list <id> List product Sessions for an issue
  issue session result list <id> List explicitly published cross-Session results
  issue session result publish <id> Publish a reusable result from one Session
                         [--type mr|report|deploy|decision|doc|other] [--ref <type>:<value>]
  issue subscriber list <id>
  issue subscriber add <id> [--user-id <member-id>]
  issue subscriber remove <id> [--user-id <member-id>]
  issue runs <id>        List task runs for an issue
  issue run-messages <task-id>
  issue rerun <id>       Enqueue a fresh issue task
  issue cancel-task <task-id>
  issue metadata list <id> List issue metadata
  issue metadata get <id> --key <k>
  issue metadata set <id> --key <k> --value <v> [--type string|number|bool]
  issue metadata delete <id> --key <k>
  project doc list <project-id> List project wiki pages and memory entries
  project doc get <project-id> <slug-or-id>
  project doc create <project-id> --kind wiki|memory --title <t>
  project doc update <project-id> <slug-or-id>
  project doc delete <project-id> <slug-or-id>
  project doc search <project-id> <query>
  project doc revisions <project-id> <slug-or-id>
  project memory recall <project-id> <query>
  project memory remember <project-id> --title <one-sentence fact>
  project memory forget <project-id> <slug-or-id>
  project memory backlinks <project-id> <slug-or-id>
  project knowledge status|backfill|verify|retry-failed [project-id]
  seed                   Create a default local agent
  version                Print Multiremi version

Options:
  --port <number>        API port for serve (default: 6120)
  --host <address>       API listen host for serve (default: 0.0.0.0)
  --token <token>        Bearer token for server/daemon auth
  --server <url>         Daemon server URL (default: http://127.0.0.1:6120)
  --output json|table    Output format for supported read commands
  --full-id              Show full IDs in supported table output
  --attachment <path>    Attach a local file to issue create/comment add (repeatable)
  --session <id>         Select a product Session for Session result commands
  --content <text>       Inline comment or published-result body
  --content-file <path>  Read a comment or published-result body from a file
  --content-stdin        Read a comment or published-result body from stdin
  --type <kind>          Published-result kind: mr|report|deploy|decision|doc|other
  --output-dir <dir>     Directory for attachment download
  --provider <name>      Limit daemon to one provider: claude or codex (default: auto-detect)
  --workspace <id>       Workspace id (default: local)
  --runtime-id <id>      Reuse a fixed runtime id
  --daemon-id <id>       Stable daemon id for local directory resources
  --daemon-port <number> Local daemon helper port (default: 6131)
  --repo-cache-root <p>  Local bare repository cache root
  --name <name>          Runtime display name
  --start                Start daemon in the background after setup
  --foreground           Run daemon in the current terminal
  --once                 Daemon exits after one poll/claimed task
  --lines <number>       Log lines for daemon logs (default: 50)
  --follow               Follow daemon logs
  --platform <name>      Service platform: launchd or systemd
  --service-dir <dir>    Directory for daemon service files
  --enable               Enable service after daemon service install
  --disable              Disable service before daemon service uninstall

Agent edit options:
  --name <name>          Change the display name
  --description <text>   Change or clear the description
  --instructions <text>  Change or clear instructions
  --avatar-url <url>     Change or clear the avatar URL
  --provider <name>      Change engine: claude or codex
  --model <model>        Change or clear the model override
  --thinking-level <v>   Change or clear the reasoning override
  --visibility <value>   Set private or workspace visibility
  --max-concurrent-tasks <n> Set concurrency from 1 to 50
  --description-file <p> Read description from a file
  --instructions-file <p> Read instructions from a file

Project knowledge options:
  --kind wiki|memory     Doc kind for project doc create/list/search
  --title <text>         Doc title (a one-sentence fact for memory add)
  --slug <slug>          Explicit slug for project doc create instead of one derived from the title
  --summary <text>       Short summary shown in listings and prompt injection
  --tags a,b             Comma-separated tags
  --pinned [true|false]  Pin the doc into the prompt injection index
  --ref <type>:<value>   Cite a source: issue:<id>, task:<id>, url:<url> (repeatable;
                         also links a published Session result)
  --expected-version <n> Fail the update when the doc moved on (409)
  --limit <n>            Result cap for project doc search
  --dry-run              Report knowledge migration work without writing
  --resume               Resume SQL/pending/failed knowledge migration rows
`);
}
