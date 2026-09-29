import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../../packages");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("new message-page callers require a reply-limit exception or a bounded algorithm", () => {
  const calls: string[] = [];
  for (const path of sources(root)) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "getTaskMessagePageRows") {
        calls.push(`${relative(root, path)}: ${node.expression.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(calls.sort()).toEqual([
    "server/src/api/realtime-fanout.ts: store.getTaskMessagePageRows",
    "server/src/store/repos/tasks-repo.ts: this.getTaskMessagePageRows",
    "server/src/store/store.ts: this.tasks.getTaskMessagePageRows",
  ].sort());
});

test("runtime route and schema audit remains executable", () => {
  const audit = Bun.spawnSync({
    cmd: [process.execPath, "tests/manual/audit-pg-reply-c1-callers.ts", "--check"],
    cwd: resolve(import.meta.dir, "../.."),
  });
  expect(audit.exitCode, audit.stderr.toString()).toBe(0);
  expect(audit.stdout.toString()).toMatch(/Audited \d+ runtime routes, \d+ source handlers, \d+ schema tables/);
}, 60_000);
