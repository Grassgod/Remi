import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { DB_REPLY_TRANSITION_EXCEPTIONS } from "../../packages/server/src/observability/request-metrics.js";

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

// These getters/listings retain large columns; static reachability is conservative, not byte evidence.
const seeds = new Set([
  "getProject", "listProjects", "searchProjects", "getAgent", "getAgentLite", "listAgents",
  "listAgentsLite", "listAgentsLiteByIds", "getAgentByName", "listSkills", "getSkill",
  "listSkillFiles", "getSkillFile", "listAgentSkills", "getTask", "listTasks", "listAgentTasks",
  "listTaskMessages", "getTaskPrompt", "getAutopilotRun", "listAutopilotRuns",
  "advanceScheduledTargetRuns", "getAutopilot", "listAutopilots", "getSubmission",
  "listSubmissionsFull", "listSubmissions", "listRunSources", "getRun", "getProjectDoc",
  "listProjectDocs", "listProjectDocRevisions", "getRepositoryWikiDoc", "listRepositoryWikiDocs",
  "listRepositoryWikiDocRevisions", "listSessionEvents", "listIssueSessionResults",
  "getIssueComment", "listIssueComments", "listIssueActivity", "listIssueTimelinePage",
  "getIssue", "listIssues", "searchIssues", "listChatMessages", "getChatMessage",
  "getChatSession", "listChatSessions",
]);
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
const routes: Array<{ key: string; file: string; line: number; calls: Set<Callable> }> = [];
for (const source of program.getSourceFiles()) {
  if (!source.fileName.startsWith(server)) continue;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body) {
      functions.set(node, calls(node.body));
      const name = (ts.isArrowFunction(node) ? undefined : node.name?.getText(source))
        ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(source) : null);
      if (name && seeds.has(name)) risk.set(node, new Set([name]));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["get", "post", "put", "patch", "delete"].includes(node.expression.name.text)) {
      const path = node.arguments[0];
      if (path && ts.isStringLiteral(path) && (path.text.startsWith("/api/") || path.text.startsWith("/internal/"))) {
        const targets = new Set<Callable>();
        for (const argument of node.arguments.slice(1)) {
          for (const target of calls(argument)) targets.add(target);
          if (ts.isIdentifier(argument)) for (const target of symbolTargets(argument)) targets.add(target);
        }
        routes.push({ key: `${node.expression.name.text.toUpperCase()} ${path.text}`,
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
  }
}
const found = routes.flatMap(route => {
  const hazards = new Set<string>();
  for (const target of route.calls) for (const name of risk.get(target) ?? []) hazards.add(name);
  return hazards.size ? [{ key: route.key, file: route.file, line: route.line, hazards: [...hazards].sort() }] : [];
});
const missing = found.filter(row => !DB_REPLY_TRANSITION_EXCEPTIONS.has(row.key));
if (missing.length) throw new Error(`Large-column callers absent from transition exceptions: ${missing.map(row => row.key).join(", ")}`);
if (!process.argv.includes("--check")) {
  writeFileSync(join(root, "reports/performance/MUL-398-c1-callers.json"), JSON.stringify(found, null, 2) + "\n");
}
console.log(`Audited ${routes.length} literal route handlers; ${found.length} conservative large-column callers; 0 missing exceptions.`);
