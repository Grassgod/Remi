import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

type LegacyMenu = {
  default?: unknown[];
  users?: Array<{
    userId?: unknown;
    userIdType?: unknown;
    label?: unknown;
    items?: unknown;
  }>;
};

const apply = process.argv.includes("--apply");
const dbPath = process.env.REMI_DB_PATH || join(homedir(), ".remi", "remi.db");
const backupOption = optionValue("--backup");
const sourceDbPath = backupOption === null
  ? dbPath
  : backupOption || `${dbPath}.pre-remi-config-purge-v2.bak`;
const db = new Database(sourceDbPath, { readonly: true });

try {
  const row = db.query(
    "SELECT value FROM remi_config WHERE section = 'botMenu' AND key = ''",
  ).get() as { value: string } | null;
  if (!row) throw new Error("legacy remi_config botMenu section was not found");
  const legacy = JSON.parse(row.value) as LegacyMenu;
  const botMenu = {
    default: Array.isArray(legacy.default) ? legacy.default : [],
    users: Array.isArray(legacy.users) ? legacy.users.map((entry, index) => {
      const userId = typeof entry.userId === "string" ? entry.userId.trim() : "";
      const userIdType = entry.userIdType === "union_id" || entry.userIdType === "user_id"
        ? entry.userIdType
        : "open_id";
      if (!userId) throw new Error(`legacy personalized menu ${index + 1} has no user id`);
      return {
        target: { type: "external", userId, userIdType },
        ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
        items: Array.isArray(entry.items) ? entry.items : [],
      };
    }) : [],
  };

  process.stdout.write(`Legacy bot menu: ${botMenu.default.length} default items, ${botMenu.users.length} personalized menus.\n`);
  if (!apply) {
    process.stdout.write("Dry run only. Re-run with --apply after reviewing the migration guide.\n");
    process.exit(0);
  }

  const serverUrl = requiredEnv("MULTIREMI_SERVER_URL").replace(/\/$/, "");
  const workspaceId = requiredEnv("MULTIREMI_WORKSPACE_ID");
  const token = requiredEnv("MULTIREMI_TOKEN");
  const response = await fetch(`${serverUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/bot-menu`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bot_menu: botMenu }),
  });
  if (!response.ok) throw new Error(`workspace bot menu update failed with HTTP ${response.status}`);
  process.stdout.write("Workspace bot menu updated. Run a dry-run publish from Settings before publishing live.\n");
} finally {
  db.close();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required with --apply`);
  return value;
}

function optionValue(name: string): string | null {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) {
    const next = process.argv[exact + 1];
    return next && !next.startsWith("--") ? next : "";
  }
  const prefix = `${name}=`;
  const entry = process.argv.find((argument) => argument.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}
