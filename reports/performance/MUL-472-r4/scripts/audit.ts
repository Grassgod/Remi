import { writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "../../../../node_modules/typescript/lib/typescript.js";

const repo = resolve(import.meta.dir, "../../../..");
const files: string[] = [];
for await (const file of new Bun.Glob("frontend/**/*.{ts,tsx}").scan({ cwd: repo })) {
  if (!/node_modules|\.next|\/dist\/|\.test\.|\/__tests__\//.test(file)) files.push(resolve(repo, file));
}
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
  skipLibCheck: true, strict: true, noEmit: true,
});
const checker = program.getTypeChecker();
// Match query-key tuples, not an options-factory allowlist. The checker resolves
// imports, aliases, spread options and local variables before comparing keys.
const families: Record<string, string[]> = {
  agents: ["workspaces", "*", "agents"], squads: ["workspaces", "*", "squads"],
  snapshot: ["workspaces", "*", "agent-task-snapshot", "list"], pins: ["pins", "*", "*", "list"],
  invitations: ["invitations", "mine"], cli: ["runtimes", "latestVersion"],
  summary: ["inbox", "*", "summary"], workbench: ["issues", "*", "workbench", "pending-count"],
  childProgress: ["issues", "*", "child-progress"], issueDetail: ["issues", "*", "detail", "*"],
  projectDetail: ["projects", "*", "detail", "*"], sessions: ["chat", "*", "sessions"],
  aggregatePending: ["chat", "*", "pending-tasks"], messagesPage: ["chat", "messages-page", "*"],
  pendingTask: ["chat", "pending-task", "*"], taskMessages: ["task-messages", "*"],
  humanRequests: ["task-human-requests", "*"],
  members: ["workspaces", "*", "members"], projectList: ["projects", "*", "list"],
};
const observerNames = new Set(["useQuery", "useSuspenseQuery", "useInfiniteQuery", "useSuspenseInfiniteQuery",
  "useQueries", "useSuspenseQueries", "prefetchQuery", "prefetchInfiniteQuery", "ensureQueryData",
  "ensureInfiniteQueryData", "fetchQuery", "fetchInfiniteQuery", "QueryObserver", "InfiniteQueryObserver", "QueriesObserver"]);
const invalidateNames = new Set(["invalidateQueries", "refetchQueries"]);
type Row = { file: string; line: number; operation: string; owner: string; expression: string; keyShapes: string[][]; keys: string[] };
const observers: Row[] = [], sources: Row[] = [], allQueryOperations: Row[] = [], allInvalidationOperations: Row[] = [], unscopedInvalidations: Row[] = [], explicitRefetches: Row[] = [];
const refetchBindings = new Map<string, string[]>();

function tuples(type: ts.Type, depth = 0): string[][] {
  if (depth > 12) return [];
  if (type.isUnion()) return type.types.flatMap(t => tuples(t, depth + 1));
  if (type.isIntersection()) return type.types.flatMap(t => tuples(t, depth + 1));
  if (checker.isTupleType(type)) return [checker.getTypeArguments(type as ts.TypeReference).map(t =>
    t.isStringLiteral() ? t.value : "*")];
  return [];
}
function queryShapes(node: ts.Node, depth = 0): string[][] {
  if (depth > 12) return [];
  const type = checker.getTypeAtLocation(node);
  const key = type.getProperty("queryKey");
  if (key) {
    const resolved = tuples(checker.getTypeOfSymbolAtLocation(key, node));
    if (resolved.some(shape => shape[0] !== "*")) return resolved;
  }
  const queries = type.getProperty("queries");
  if (queries) {
    const q = checker.getTypeOfSymbolAtLocation(queries, node);
    const item = checker.getIndexTypeOfType(q, ts.IndexKind.Number);
    if (item) {
      const members = item.isUnion() ? item.types : [item];
      return members.flatMap(t => {
        const k = t.getProperty("queryKey");
        return k ? tuples(checker.getTypeOfSymbolAtLocation(k, node)) : [];
      });
    }
  }
  const direct = tuples(type);
  if (direct.some(shape => shape[0] !== "*")) return direct;
  if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(property => {
    if (ts.isSpreadAssignment(property)) return queryShapes(property.expression, depth + 1);
    if (ts.isPropertyAssignment(property) && property.name.getText() === "queryKey") return queryShapes(property.initializer, depth + 1);
    return [];
  });
  if (ts.isArrayLiteralExpression(node)) return [node.elements.flatMap(element =>
    ts.isSpreadElement(element) ? queryShapes(element.expression, depth + 1)[0] ?? ["*"]
      : [ts.isStringLiteral(element) ? element.text : "*"])];
  if (ts.isCallExpression(node)) {
    if (["queryOptions", "infiniteQueryOptions"].includes(nameOf(node.expression))) return node.arguments.flatMap(arg => queryShapes(arg, depth + 1));
    let symbol = checker.getSymbolAtLocation(node.expression);
    if (symbol?.flags && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const result: string[][] = [];
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) {
        const returns = (child: ts.Node) => {
          if (ts.isReturnStatement(child) && child.expression) result.push(...queryShapes(child.expression, depth + 1));
          else ts.forEachChild(child, returns);
        };
        returns(declaration.body);
      }
    }
    return result;
  }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return queryShapes(declaration.initializer, depth + 1);
  }
  return [];
}
function match(shape: string[], pattern: string[], prefix: boolean): boolean {
  if (shape.length > pattern.length || (!prefix && shape.length !== pattern.length) || shape[0] === "*") return false;
  return shape.every((part, i) => pattern[i] === "*" || part === pattern[i]);
}
function nameOf(expression: ts.Expression): string {
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
  if (symbol?.flags && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.getName() ?? (ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText());
}
function ownerOf(node: ts.Node): string {
  let p: ts.Node | undefined = node.parent;
  const labels: string[] = [];
  while (p) {
    if (ts.isPropertyAssignment(p)) labels.unshift(p.name.getText());
    if (ts.isFunctionDeclaration(p)) { labels.unshift(p.name?.text ?? "anonymous"); break; }
    if (ts.isVariableDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer)
      || (ts.isCallExpression(p.initializer) && ["memo", "forwardRef"].includes(nameOf(p.initializer.expression))))) {
      labels.unshift(p.name.getText()); break;
    }
    p = p.parent;
  }
  return labels.join(" / ") || "module";
}
for (const file of files.sort()) {
  const source = program.getSourceFile(file)!;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const operation = nameOf(node.expression);
      if (observerNames.has(operation) || invalidateNames.has(operation)) {
        const argument = node.arguments?.[operation.endsWith("Observer") ? 1 : 0];
        const keyShapes = argument ? queryShapes(argument) : [];
        // useQueries maps can produce a readonly tuple of options whose item
        // type is widened; inspect the map body's options as well.
        if (argument && operation.includes("Queries")) {
          const walk = (child: ts.Node) => { if (ts.isObjectLiteralExpression(child) || ts.isCallExpression(child)) keyShapes.push(...queryShapes(child)); ts.forEachChild(child, walk); };
          ts.forEachChild(argument, walk);
        }
        const keys = Object.entries(families).filter(([, pattern]) => keyShapes.some(s => match(s, pattern, invalidateNames.has(operation)))).map(([key]) => key);
        const row: Row = { file: relative(repo, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          operation, owner: ownerOf(node), expression: node.getText(source), keyShapes, keys };
        if (observerNames.has(operation)) { allQueryOperations.push(row); if (keys.length) observers.push(row); }
        else {
          allInvalidationOperations.push(row);
          if (keys.length) sources.push(row);
          else if (!keyShapes.length || keyShapes.every(shape => shape[0] === "*")) unscopedInvalidations.push(row);
        }
        const declaration = node.parent;
        if (keys.length && ts.isVariableDeclaration(declaration)) {
          if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (["refetch", "fetchNextPage", "fetchPreviousPage"].includes(element.propertyName?.getText() ?? element.name.getText())) {
                refetchBindings.set(`${file}:${element.name.getText()}`, keys);
              }
            }
          } else refetchBindings.set(`${file}:${declaration.name.getText()}.refetch`, keys);
        }
      }
      if (/refetch|fetchNextPage|fetchOlderMessages|refetchMessages|refetchSessions/i.test(operation)
        && !observerNames.has(operation) && !invalidateNames.has(operation)) {
        explicitRefetches.push({ file: relative(repo, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          operation, owner: ownerOf(node), expression: node.getText(source), keyShapes: [], keys: [] });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const row of explicitRefetches) {
  row.keys = refetchBindings.get(`${resolve(repo, row.file)}:${row.expression.split("(")[0]}`) ?? [];
}
const old = await Bun.file(resolve(repo, "reports/performance/MUL-472-r3/MUL-472-r3-observers.json")).json();
function classification(row: Row): { category: string; reason: string } {
  const previous = old.calls.find((c: {file: string; owner: string; factory: string}) => c.file === row.file && row.owner.startsWith(c.owner) && row.expression.includes(c.factory));
  if (row.file.endsWith("chat-message-list.tsx")) return { category: "可见性门控", reason: "ChatWindow 常驻隐藏子树；visible && 原合法 task 条件。历史回复与 live timeline 都不承担隐藏窗口角标。" };
  if (row.file.endsWith("human-request-dock.tsx")) return { category: "可见性 / 详情主体", reason: "聊天调用 enabled=chatVisible；AgentLiveCard 的可见任务交互表单保留默认 enabled=true。" };
  if (row.file.endsWith("session-agent-stream-row.tsx")) return { category: "不门控（详情主体）", reason: "详情会话中的执行行；任务进度是主体输入，degraded header 必须继续刷新。" };
  if (row.owner === "TranscriptButton" || row.owner === "openPicker") return { category: "不等首屏 gate（交互）", reason: "用户展开 transcript 或父单选择器后才启用/执行。" };
  if (row.keys.some(key => ["members", "projectList"].includes(key))) return row.owner === "ChatWindow"
    ? { category: "可见性门控", reason: "隐藏聊天的提及候选数据，只在 chatVisible 时订阅；同 key 的主体和权限 observer 见其余行。" }
    : { category: "不门控（主体 / 权限 / 交互）", reason: "项目主体列表、成员权限或已打开控件依赖；保留原 enabled，不能被隐藏聊天的延后策略限制。原表达式逐行列出。" };
  if (previous) return { category: previous.category, reason: previous.reason };
  return { category: "待逐项核对", reason: "新增的直接 key 或 options 调用，见原表达式。" };
}
writeFileSync(resolve(import.meta.dir, "../MUL-472-r4-key-audit.json"), JSON.stringify({
  scope: "All frontend runtime TypeScript; query-key tuples resolved by TypeScript checker, no factory allowlist. Full inventory retained for unresolved/manual checks.",
  families, observers: observers.map(r => ({ ...r, ...classification(r) })), sources: sources.map(r => ({ ...r,
    closedGate: "invalidate 默认只重拉 active observer；refetchQueries 跳过 disabled observer。本清单没有 refetchQueries / refetchType=all 来源；附属 enabled=false 时仅 stale，主体或已打开交互同 key observer 是分类表例外。" })),
  unscopedInvalidations, explicitRefetches, allQueryOperations, allInvalidationOperations,
  unresolvedOperations: allQueryOperations.filter(r => !r.keyShapes.length || r.keyShapes.every(shape => shape[0] === "*")),
}, null, 2));
console.log(JSON.stringify({ observers: observers.length, sources: sources.length, allOperations: allQueryOperations.length,
  unresolved: allQueryOperations.filter(r => !r.keyShapes.length || r.keyShapes.every(shape => shape[0] === "*" )).length, unscopedInvalidations: unscopedInvalidations.length }));
