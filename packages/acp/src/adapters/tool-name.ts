/**
 * Shared tool-name heuristics for the ACP adapters.
 *
 * ACP does not carry a canonical tool name: agents put it in `_meta`, in
 * `rawInput`, in `kind`, or only in the human-readable `title`. Both the claude
 * and the codex adapter therefore fall back to guessing from the title. The
 * table below is that single guess — it used to exist as two drifted copies
 * (claude knew `glob`/`agent`, codex knew `shell`/`patch`/`diff`/`think`/`plan`
 * and separator-insensitive matching), so a title only one copy understood
 * resolved differently depending on which agent produced it.
 */

/** Names the adapters may hand back verbatim once `canonicalToolName` agrees. */
export const KNOWN_TOOL_NAMES = new Set([
  "Bash", "Read", "Write", "Edit", "Grep", "WebFetch", "WebSearch", "Think",
  "TodoWrite", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "Agent", "Glob",
]);

/** Lower-case, separator-free form: `apply_patch`, `Apply Patch` and `apply-patch` all collapse. */
function compact(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, "");
}

/**
 * Canonicalise an exact tool name (not a sentence). Returns the input unchanged
 * when no alias matches, and `null` when the name carries no letters at all —
 * callers decide what a blank name means.
 */
export function canonicalToolName(name: string): string | null {
  const lower = compact(name);
  if (!lower) return null;
  if (["bash", "shell", "exec", "execute", "command", "commandexecution"].includes(lower)) return "Bash";
  if (["read", "readfile", "fileread"].includes(lower)) return "Read";
  if (["write", "writefile", "create", "createfile", "filewrite"].includes(lower)) return "Write";
  if (["edit", "applypatch", "patch", "filechange", "fileedit"].includes(lower)) return "Edit";
  if (["grep", "search", "filesearch", "rg"].includes(lower)) return "Grep";
  if (["webfetch", "fetch", "openurl"].includes(lower)) return "WebFetch";
  if (["websearch", "searchweb"].includes(lower)) return "WebSearch";
  if (["think", "reasoning"].includes(lower)) return "Think";
  if (["todo", "todowrite", "plan"].includes(lower)) return "TodoWrite";
  if (["askuserquestion", "ask", "askuser"].includes(lower)) return "AskUserQuestion";
  if (["exitplanmode", "planmode", "readytocode"].includes(lower)) return "ExitPlanMode";
  if (["enterplanmode"].includes(lower)) return "EnterPlanMode";
  if (["agent", "spawnagent"].includes(lower)) return "Agent";
  if (["glob"].includes(lower)) return "Glob";
  return name;
}

/**
 * Guess a tool name from a human-readable title. Exact names win first, so a
 * title that *is* a tool name (`ExitPlanMode`, `apply_patch`) never falls into
 * the substring heuristics below it.
 */
export function titleToToolName(title: string): string {
  const exact = canonicalToolName(title) ?? "unknown";
  if (exact !== title || KNOWN_TOOL_NAMES.has(exact)) return exact;

  const lower = title.toLowerCase();
  const flat = compact(title);
  if (flat.includes("bash") || flat.includes("terminal") || flat.includes("shell")) return "Bash";
  if (flat === "read" || lower.startsWith("read ")) return "Read";
  if (flat.includes("write") || flat.includes("create")) return "Write";
  if (flat.includes("edit") || flat.includes("patch") || flat.includes("diff")) return "Edit";
  if (flat.includes("glob")) return "Glob";
  if (flat.includes("grep") || flat.includes("searchfile") || lower.startsWith("search ")) return "Grep";
  if (flat.includes("websearch")) return "WebSearch";
  if (flat.includes("webfetch") || flat.includes("fetch")) return "WebFetch";
  if (flat.includes("agent")) return "Agent";
  if (flat.includes("think") || flat.includes("reason")) return "Think";
  if (flat.includes("todo") || flat.includes("plan")) return "TodoWrite";
  return title || "unknown";
}
