import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const outIndex = process.argv.indexOf("--out");
const rootIndex = process.argv.indexOf("--root");
const onlyIndex = process.argv.indexOf("--only");
const output = process.argv[outIndex + 1];
if (outIndex < 0 || !output) throw new Error("--out is required");
const probe = resolve(import.meta.dir, "probe-pg-reply-c1-routes.ts");
const source = ts.createSourceFile(probe, readFileSync(probe, "utf8"), ts.ScriptTarget.Latest, true);
const columns: string[] = [];
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "seeds" && node.initializer) {
    const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
    if (!ts.isArrayLiteralExpression(initializer)) throw new Error("fixture seeds must be an array");
    for (const entry of initializer.elements) {
      if (!ts.isArrayLiteralExpression(entry)) throw new Error("fixture seed must be a tuple");
      const [table, column] = entry.elements;
      if (!table || !column || !ts.isStringLiteral(table) || !ts.isStringLiteral(column)) {
        throw new Error("fixture seed needs literal schema identifiers");
      }
      columns.push(`${table.text}.${column.text}`);
    }
  }
  ts.forEachChild(node, visit);
};
visit(source);
if (!columns.length) throw new Error("No fixture categories found");
const selected = onlyIndex < 0 ? columns : columns.filter(column => column === process.argv[onlyIndex + 1]);
if (!selected.length) throw new Error("Unknown fixture category");
const results: Array<{ column: string; routeCount: number; rows: unknown[] }> = onlyIndex >= 0 && existsSync(output)
  ? JSON.parse(readFileSync(output, "utf8")) : [];
for (const [index, column] of selected.entries()) {
  const temporary = `${output}.part`;
  const cmd = [process.execPath, probe, "--scenario", column, "--out", temporary];
  if (rootIndex >= 0) cmd.push("--root", process.argv[rootIndex + 1]!);
  if (process.argv.includes("--enforce")) cmd.push("--enforce");
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`Fixture ${column} failed (${status}): ${stderr.slice(-2000)}`);
  }
  const result = JSON.parse(readFileSync(temporary, "utf8")) as { routeCount: number; rows: unknown[] };
  rmSync(temporary);
  const previous = results.findIndex(row => row.column === column);
  if (previous < 0) results.push({ column, ...result });
  else results[previous] = { column, ...result };
  writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
  console.log(`${index + 1}/${selected.length} ${column}: ${stdout.trim().split("\n").at(-1)}`);
}
results.sort((a, b) => columns.indexOf(a.column) - columns.indexOf(b.column));
writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
