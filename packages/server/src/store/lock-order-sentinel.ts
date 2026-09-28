/**
 * Whole-suite enforcement of the MUL-405 lock order (W -> N -> D).
 *
 * The contract lives in `./advisory-locks.ts`: a transaction takes the
 * workspace lifecycle row lock (W), then any number-allocation advisory lock
 * (N), then domain row locks (D). Two earlier QA rounds found real inversions
 * only because a human searched the repository by hand — the enumerated
 * per-path tests in `tests/unit/multiremi/mul405-lock-order-paths.test.ts` are
 * good at pinning the paths they list, and blind to the paths they do not.
 *
 * This module closes that gap: the shared database wrapper classifies every
 * statement of every transaction and throws the moment a class is taken after a
 * higher one. It is therefore a check on the whole suite, not on a list.
 *
 * Rules, matching how a deadlock reads the trace:
 *
 *   - only the FIRST acquisition of each class is ordered; re-taking a lock the
 *     transaction already holds is free in PostgreSQL and the store relies on
 *     it (Feishu ingest takes W, then the Task writer takes W again);
 *   - a class whose first acquisition ranks below a class already acquired is a
 *     violation — `D -> W` and `D -> N` are the shapes that formed the cycle;
 *   - nothing is checked outside a transaction, where "first" has no meaning.
 *
 * Classification. W is the `updated_at = updated_at` workspace row lock. N is
 * any `advisoryXactLock` call. D is any other write or a locking SELECT on a
 * domain table: a transaction that writes a domain row has taken a row lock on
 * PostgreSQL, whether or not the statement
 * is a no-op whose only purpose is the lock. That breadth is deliberate — it is
 * what caught `archiveAgent` writing `UPDATE multiremi_agents` before the audit
 * number lock.
 *
 * SQLite has no advisory locks, so on SQLite N never appears and only the W/D
 * relation is enforced. PostgreSQL enforces all three.
 *
 * Enablement: `MULTIREMI_TEST_LOCK_ORDER_SENTINEL=1`, set by the `bun test`
 * preload (`tests/setup/hermetic-env-policy.ts`). It is refused under
 * `NODE_ENV=production` regardless of the variable, and the check is a single
 * cached boolean read when off, so production pays nothing.
 */

export type LockOrderClass = "W" | "N" | "D";

const RANK: Record<LockOrderClass, number> = { W: 0, N: 1, D: 2 };

/** The workspace lifecycle row lock (`StoreContext.lockWorkspaceRuntimeLifecycle`). */
const WORKSPACE_ROW_LOCK = /UPDATE\s+multiremi_workspaces\s+SET\s+updated_at\s*=\s*updated_at/i;

interface SqlToken { text: string; kind: "word" | "identifier" | "literal" | "symbol" }
interface SqlGroup { tokens: SqlNode[] }
type SqlNode = SqlToken | SqlGroup;
interface SelectLocks { tables: string[]; classes: LockOrderClass[] }
interface FromReference { name: string; tables: string[] }

function keyword(node: SqlNode | undefined, text: string): boolean {
  return node !== undefined && "text" in node && node.kind === "word" && node.text === text;
}

function symbol(node: SqlNode | undefined, text: string): boolean {
  return node !== undefined && "text" in node && node.kind === "symbol" && node.text === text;
}

function identifier(node: SqlNode | undefined): string | null {
  return node !== undefined && "text" in node && (node.kind === "word" || node.kind === "identifier")
    ? node.text : null;
}

/** SQL lexical boundaries matter: comments and literals cannot acquire locks. */
function sqlNodes(sql: string): SqlNode[] {
  const root: SqlNode[] = [];
  const stack = [root];
  for (let i = 0; i < sql.length;) {
    const nodes = stack[stack.length - 1]!;
    const ch = sql[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) { depth += 1; i += 2; }
        else if (sql.startsWith("*/", i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    if (ch === "'") {
      const escaped = /(?:^|[^\w$])E$/i.test(sql.slice(0, i));
      i += 1;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i++] === "'") break;
      }
      nodes.push({ text: "", kind: "literal" });
      continue;
    }
    if (ch === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(delimiter, i + delimiter.length);
      i = end < 0 ? sql.length : end + delimiter.length;
      nodes.push({ text: "", kind: "literal" });
      continue;
    }
    if (ch === '"') {
      let text = "";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { text += '"'; i += 2; }
        else if (sql[i] === '"') { i += 1; break; }
        else text += sql[i++];
      }
      nodes.push({ text, kind: "identifier" });
      continue;
    }
    if (ch === "(") {
      const group: SqlGroup = { tokens: [] };
      nodes.push(group);
      stack.push(group.tokens);
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (stack.length > 1) stack.pop();
      i += 1;
      continue;
    }
    const word = /^[A-Za-z_][\w$]*/.exec(sql.slice(i));
    if (word) {
      nodes.push({ text: word[0].toLowerCase(), kind: "word" });
      i += word[0].length;
    } else {
      nodes.push({ text: ch, kind: "symbol" });
      i += 1;
    }
  }
  return root;
}

const FROM_END = new Set(["where", "group", "having", "window", "order", "limit", "offset", "fetch", "for", "union", "intersect", "except", "returning"]);
const ALIAS_END = new Set([...FROM_END, "join", "inner", "left", "right", "full", "cross", "natural", "outer", "on", "using", "tablesample", "set"]);

function rowLockClass(table: string): LockOrderClass {
  return table === "multiremi_workspaces" ? "W" : "D";
}

function fromReferences(
  nodes: SqlNode[],
  ctes: ReadonlySet<string>,
  children: Map<SqlGroup, SelectLocks>,
  joinedGroup = false,
): FromReference[] {
  const refs: FromReference[] = [];
  let inFrom = joinedGroup;
  let source = joinedGroup;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    if (keyword(node, "from") || keyword(node, "join")) { inFrom = true; source = true; continue; }
    if ("text" in node && node.kind === "word" && FROM_END.has(node.text)) inFrom = false;
    if (inFrom && "text" in node && node.text === ",") { source = true; continue; }
    if (!inFrom || !source) continue;
    if (keyword(node, "only") || keyword(node, "lateral")) continue;
    source = false;
    let name = "";
    let tables: string[];
    let groupedRefs: FromReference[] | undefined;
    if ("tokens" in node) {
      if (keyword(node.tokens[0], "select") || keyword(node.tokens[0], "with")) {
        tables = (children.get(node) ?? selectLocks(node.tokens, ctes)).tables;
      } else {
        groupedRefs = fromReferences(node.tokens, ctes, children, true);
        tables = groupedRefs.flatMap((ref) => ref.tables);
      }
    } else {
      const first = identifier(node);
      if (!first) continue;
      name = first;
      let qualified = false;
      while (symbol(nodes[i + 1], ".") && identifier(nodes[i + 2])) {
        qualified = true;
        name = identifier(nodes[i + 2])!;
        i += 2;
      }
      tables = !qualified && ctes.has(name) ? [] : [name];
      if (nodes[i + 1] && "tokens" in nodes[i + 1]!) { tables = []; i += 1; } // FROM function(...)
    }
    if (symbol(nodes[i + 1], "*")) i += 1;
    if (keyword(nodes[i + 1], "as")) i += 1;
    const aliasNode = nodes[i + 1];
    const alias = identifier(aliasNode);
    if (alias && aliasNode && "text" in aliasNode && (aliasNode.kind === "identifier" || !ALIAS_END.has(alias))) {
      name = alias;
      i += 1;
    }
    if (!name && groupedRefs) refs.push(...groupedRefs);
    else refs.push({ name, tables });
  }
  return refs;
}

/** Analyze SELECT scopes so OF aliases, subqueries and WITH queries stay distinct. */
function selectLocks(nodes: SqlNode[], inheritedCtes: ReadonlySet<string> = new Set()): SelectLocks {
  const ctes = new Set(inheritedCtes);
  const classes: LockOrderClass[] = [];
  if (keyword(nodes[0], "with")) {
    const bodies: SqlGroup[] = [];
    let i = keyword(nodes[1], "recursive") ? 2 : 1;
    while (i < nodes.length) {
      const name = identifier(nodes[i]);
      if (!name) break;
      ctes.add(name);
      i += 1;
      if (nodes[i] && "tokens" in nodes[i]!) i += 1; // Optional column names.
      if (!keyword(nodes[i], "as")) break;
      i += 1;
      if (keyword(nodes[i], "not")) i += 1;
      if (keyword(nodes[i], "materialized")) i += 1;
      const body = nodes[i];
      if (!body || !("tokens" in body)) break;
      bodies.push(body);
      i += 1;
      if (!symbol(nodes[i], ",")) break;
      i += 1;
    }
    // A top-level FOR clause does not propagate into CTEs. Their own clauses do.
    for (const body of bodies) classes.push(...selectLocks(body.tokens, ctes).classes);
    nodes = nodes.slice(i);
  }
  const children = new Map<SqlGroup, SelectLocks>();
  for (const node of nodes) {
    if (!("tokens" in node)) continue;
    const child = selectLocks(node.tokens, ctes);
    if (keyword(node.tokens[0], "select") || keyword(node.tokens[0], "with")) children.set(node, child);
    classes.push(...child.classes);
  }
  if (!keyword(nodes[0], "select")) {
    if (["insert", "update", "delete", "merge"].some((word) => keyword(nodes[0], word))) {
      classes.push(...classifyStatementNodes(nodes));
    }
    return { tables: [], classes };
  }
  const refs = fromReferences(nodes, ctes, children);
  const targets = new Set<string>();
  let all = false;
  for (let i = 0; i < nodes.length; i += 1) {
    if (!keyword(nodes[i], "for")) continue;
    let end = i + 1;
    if (keyword(nodes[end], "no") && keyword(nodes[end + 1], "key")) end += 2;
    else if (keyword(nodes[end], "key")) end += 1;
    if (!keyword(nodes[end], "update") && !keyword(nodes[end], "share")) continue;
    end += 1;
    if (!keyword(nodes[end], "of")) { all = true; continue; }
    do {
      end += 1;
      const name = identifier(nodes[end]);
      if (!name) break;
      targets.add(name);
      end += 1;
    } while (symbol(nodes[end], ","));
  }
  const locked = refs.filter((ref) => all || targets.has(ref.name));
  for (const ref of locked) classes.push(...ref.tables.map(rowLockClass));
  return { tables: refs.flatMap((ref) => ref.tables), classes };
}

function classifyStatementNodes(nodes: SqlNode[]): LockOrderClass[] {
  if (nodes.length === 0 || keyword(nodes[0], "pragma") || keyword(nodes[0], "explain")) return [];
  // Transaction characteristics do not acquire row locks (e.g. S9-3a snapshots).
  if (keyword(nodes[0], "set") && keyword(nodes[1], "transaction")) return [];
  if (keyword(nodes[0], "select") || keyword(nodes[0], "with")) {
    return [...new Set(selectLocks(nodes).classes)];
  }
  const text = nodes.map((node) => "text" in node ? node.text : "()").join(" ");
  return [WORKSPACE_ROW_LOCK.test(text) ? rowLockClass("multiremi_workspaces") : "D"];
}

/**
 * Shared SQL classification for the whole-suite sentinel and per-path recorder.
 * W keeps the existing workspace lifecycle UPDATE rule; locking SELECTs use
 * the same workspace/domain table identities. N is supplied by the advisory
 * lock API, not inferred from a table or from text inside a SELECT.
 */
export function classifyLockOrderStatement(sql: string): LockOrderClass[] {
  const statements: SqlNode[][] = [[]];
  for (const node of sqlNodes(sql)) {
    if (symbol(node, ";")) statements.push([]);
    else statements[statements.length - 1]!.push(node);
  }
  return [...new Set(statements.flatMap(classifyStatementNodes))];
}

interface Frame {
  acquired: Set<LockOrderClass>;
  highest: number;
  trace: string[];
}

const frames: Frame[] = [];
let enabledCache: boolean | null = null;

/** True when the sentinel should classify statements. Cached: the env is read once. */
export function lockOrderSentinelEnabled(): boolean {
  if (enabledCache === null) {
    enabledCache = process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL === "1"
      && process.env.NODE_ENV !== "production";
  }
  return enabledCache;
}

/** Test-only escape hatch: forget the cached enablement (used by the guard test). */
export function resetLockOrderSentinelEnabledCache(): void {
  enabledCache = null;
}

/** Outermost transaction opened. Nested `transaction()` calls do not start a frame. */
export function lockOrderSentinelTransactionBegin(): void {
  if (!lockOrderSentinelEnabled()) return;
  frames.push({ acquired: new Set(), highest: -1, trace: [] });
}

/** Outermost transaction closed (commit or rollback). */
export function lockOrderSentinelTransactionEnd(): void {
  if (!lockOrderSentinelEnabled()) return;
  frames.pop();
}

/**
 * Classify one statement. W and D come from SQL; N cannot (it is an advisory
 * lock call, see {@link lockOrderSentinelNoteNumberLock}).
 */
export function lockOrderSentinelNoteStatement(sql: string): void {
  if (!lockOrderSentinelEnabled()) return;
  const frame = frames[frames.length - 1];
  if (!frame) return;
  const translated = sql.replace(/\s+/g, " ").trim();
  for (const cls of classifyLockOrderStatement(sql)) record(frame, cls, translated);
}

/** The database took a number-allocation advisory lock. */
export function lockOrderSentinelNoteNumberLock(key: string): void {
  if (!lockOrderSentinelEnabled()) return;
  const frame = frames[frames.length - 1];
  if (!frame) return;
  record(frame, "N", `pg_advisory_xact_lock(${key})`);
}

function record(frame: Frame, cls: LockOrderClass, detail: string): void {
  const trimmed = detail.slice(0, 140);
  if (frame.acquired.has(cls)) return;
  const rank = RANK[cls];
  if (rank < frame.highest) {
    const order = [...frame.trace, `${cls} ${trimmed}`].join("\n  ");
    throw new Error(
      `MUL-405 lock order violated: first ${cls} acquisition comes after a higher class ` +
        `(W -> N -> D required).\nTrace:\n  ${order}\nStack:\n${new Error().stack ?? "(no stack)"}`,
    );
  }
  frame.acquired.add(cls);
  frame.highest = Math.max(frame.highest, rank);
  frame.trace.push(`${cls} ${trimmed}`);
}
