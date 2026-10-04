import { parseArgs } from "node:util";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openConversationLogTarget, readOnlyConversationTransaction } from "./reconcile-conversation-log.js";
import { reconcileUnifiedModel, type UnifiedModelReport } from "../packages/server/src/store/unified-model-migration.js";

export function runUnifiedReconciliation(input: { sqlite?: string; postgresEnv?: string; before?: UnifiedModelReport }): UnifiedModelReport {
  const db = openConversationLogTarget({ sqlite: input.sqlite, pgEnv: input.postgresEnv });
  try { return readOnlyConversationTransaction(db, () => reconcileUnifiedModel(db, input.before)); }
  finally { db.close(); }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    sqlite: { type: "string" }, "postgres-env": { type: "string" }, before: { type: "string" },
    out: { type: "string", default: "reports/migrations/unified-model-reconciliation.json" }, help: { type: "boolean" },
  } });
  if (values.help || Boolean(values.sqlite) === Boolean(values["postgres-env"])) {
    console.log("Usage: bun run scripts/reconcile-unified-model.ts (--sqlite PATH | --postgres-env ENV_NAME) [--before BEFORE_REPORT] [--out JSON_PATH]");
    process.exit(values.help ? 0 : 2);
  }
  if (values["postgres-env"] && !process.env[values["postgres-env"]]) throw new Error("Selected PostgreSQL environment variable is not set");
  const before = values.before ? JSON.parse(readFileSync(values.before,"utf8")) as UnifiedModelReport : undefined;
  const report = runUnifiedReconciliation({ sqlite: values.sqlite, postgresEnv: values["postgres-env"], before });
  mkdirSync(dirname(values.out!),{ recursive: true });
  writeFileSync(values.out!,JSON.stringify(report,null,2)+"\n",{ mode: 0o600 });
  console.log(JSON.stringify({ counts: report.counts, mismatches: report.mismatches, report: values.out }));
  process.exitCode = report.mismatches.length ? 1 : 0;
}
