/** Deprecated command alias. Context `used` is never accumulated as consumption. */
import { mainReconcileTaskUsage } from "./reconcile-task-usage.js";
if (import.meta.main) {
  if (process.argv.includes("--execute")) throw new Error("The old context-summing backfill is retired. Review a plan from reconcile-task-usage.ts.");
  process.stderr.write("Deprecated: use scripts/reconcile-task-usage.ts for a read-only evidence plan.\n");
  await mainReconcileTaskUsage();
}
