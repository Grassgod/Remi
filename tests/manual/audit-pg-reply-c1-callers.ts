import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import ts from "typescript";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import { DB_REPLY_TRANSITION_EXCEPTIONS } from "../../packages/server/src/observability/request-metrics.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";

const root = resolve(import.meta.dir, "../..");
const server = join(root, "packages/server/src");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}
const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const program = ts.createProgram(files(server), options);
const checker = program.getTypeChecker();
const schema = new Database(":memory:");
const app = createMultiremiApp({ store: new MultiremiStore(schema), backgroundJobs: false, authToken: "audit" });
const runtimeRoutes = new Set(app.routes.filter(route => route.method !== "ALL")
  .map(route => `${route.method} ${route.path}`));
const tableNames = (schema.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'multiremi_%'")
  .all() as Array<{ name: string }>).map(row => row.name);
const largeColumns = new Map(tableNames.map(table => [table,
  (schema.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }> )
    .filter(column => /TEXT|JSON|BLOB|BYTEA/i.test(column.type)).map(column => column.name),
] as const).filter(([, columns]) => columns.length > 0));
schema.close();
type Callable = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;
function callable(declaration: ts.Declaration): Callable | null {
  if (ts.isVariableDeclaration(declaration) && declaration.initializer
    && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
    return declaration.initializer;
  }
  return (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)
    || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) && declaration.body
    ? declaration : null;
}
function symbolTargets(node: ts.Node): Set<Callable> {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
  const result = new Set<Callable>();
  for (const declaration of symbol?.declarations ?? []) {
    const target = callable(declaration);
    if (target) result.add(target);
  }
  return result;
}
function constantString(node: ts.Expression, seen = new Set<ts.Symbol>()): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression, seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left, seen);
    const right = constantString(node.right, seen);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const part = constantString(span.expression, seen);
      if (part === null) return null;
      value += part + span.literal.text;
    }
    return value;
  }
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || seen.has(symbol)) return null;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const value = constantString(declaration.initializer, seen);
        if (value !== null) return value;
      }
    }
  }
  return null;
}
function sqlHazards(body: ts.Node): Set<string> {
  const hazards = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const sql = node.getText().replace(/\$\{[^}]+\}/g, " ");
      if (/\bSELECT\b/i.test(sql)) {
        for (const [table, columns] of largeColumns) {
          if (new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, "i").test(sql)) {
            hazards.add(`${table}(${columns.join(",")})`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return hazards;
}
function calls(node: ts.Node): Set<Callable> {
  const result = new Set<Callable>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      for (const target of symbolTargets(child.expression)) result.add(target);
      const declaration = checker.getResolvedSignature(child)?.declaration;
      const target = declaration ? callable(declaration) : null;
      if (target) result.add(target);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}
const functions = new Map<Callable, Set<Callable>>();
const risk = new Map<Callable, Set<string>>();
const dbReads = new Set<Callable>();
const routes: Array<{ key: string; file: string; line: number; calls: Set<Callable> }> = [];
for (const source of program.getSourceFiles()) {
  if (!source.fileName.startsWith(server)) continue;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body) {
      functions.set(node, calls(node.body));
      const hazards = sqlHazards(node.body);
      if (hazards.size) risk.set(node, hazards);
      if (/\b(?:SELECT|WITH)\b/i.test(node.body.getText(source))) dbReads.add(node);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["get", "post", "put", "patch", "delete", "options", "head", "all", "on"].includes(node.expression.name.text)) {
      const path = node.arguments[0];
      const routePath = path ? constantString(path) : null;
      if (routePath?.startsWith("/")) {
        const targets = new Set<Callable>();
        for (const argument of node.arguments.slice(1)) {
          for (const target of calls(argument)) targets.add(target);
          if (ts.isIdentifier(argument)) for (const target of symbolTargets(argument)) targets.add(target);
        }
        routes.push({ key: `${node.expression.name.text.toUpperCase()} ${routePath}`,
          file: relative(root, source.fileName),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, calls: targets });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
for (let changed = true; changed;) {
  changed = false;
  for (const [node, targets] of functions) {
    const hazards = risk.get(node) ?? new Set<string>();
    for (const target of targets) for (const name of risk.get(target) ?? []) {
      if (!hazards.has(name)) { hazards.add(name); changed = true; }
    }
    if (hazards.size) risk.set(node, hazards);
    if (targets.size && [...targets].some(target => dbReads.has(target)) && !dbReads.has(node)) {
      dbReads.add(node);
      changed = true;
    }
  }
}
const found = routes.flatMap(route => {
  const hazards = new Set<string>();
  for (const target of route.calls) for (const name of risk.get(target) ?? []) hazards.add(name);
  return hazards.size ? [{ key: route.key, file: route.file, line: route.line, hazards: [...hazards].sort() }] : [];
});
const missing = found.filter(row => !DB_REPLY_TRANSITION_EXCEPTIONS.has(row.key));
const discovered = new Set(routes.map(route => route.key));
const unclassified = [...runtimeRoutes].filter(key => !DB_REPLY_TRANSITION_EXCEPTIONS.has(key) && !discovered.has(key));
const stale = routes.filter(route => !runtimeRoutes.has(route.key));
if (process.argv.includes("--list-missing")) {
  console.log(JSON.stringify({
    runtimeRoutes: runtimeRoutes.size,
    sourceHandlers: routes.length,
    schemaColumns: [...largeColumns.values()].reduce((sum, columns) => sum + columns.length, 0),
    missing, unclassified, stale: stale.map(row => row.key),
  }));
  process.exit(0);
}
if (process.argv.includes("--enforce") && (missing.length || unclassified.length || stale.length)) throw new Error(JSON.stringify({
  missingCount: missing.length, missing: missing.slice(0, 12).map(row => row.key),
  unclassified, stale: stale.map(row => row.key),
}));
if (process.argv.includes("--write-snapshot")) {
  writeFileSync(join(root, "reports/performance/MUL-398-c1-callers.json"), JSON.stringify(found, null, 2) + "\n");
}
console.log(`Audited ${runtimeRoutes.size} runtime routes, ${routes.length} source handlers, ${largeColumns.size} schema tables; ${found.length} conservative large-column callers; ${missing.length} unreviewed candidates, ${unclassified.length} unmapped runtime routes, ${stale.length} stale source routes.`);
