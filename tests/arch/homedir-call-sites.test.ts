import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../..");

// Existing production home reads. New defaults need an isolation review, even
// inside a file that already reads home; lowering a count needs no exemption.
const HOME_CALL_LIMITS: Readonly<Record<string, number>> = {
  "packages/acp/src/antigravity.ts": 2,
  "packages/acp/src/client.ts": 2,
  "packages/acp/src/provider.ts": 7,
  "packages/acp/src/provision.ts": 2,
  "packages/acp/src/runtime-bundle.ts": 1,
  "packages/auth/src/oauth-cli.ts": 1,
  "packages/auth/src/token-sync.ts": 1,
  "packages/connectors/src/feishu/index.ts": 1,
  "packages/connectors/src/feishu/receive.ts": 1,
  "packages/daemon/src/agent-runtime/agent-plugins/cache.ts": 1,
  "packages/daemon/src/agent-runtime/workspace/ephemeral.ts": 2,
  "packages/daemon/src/agent-runtime/workspace/persistent.ts": 1,
  "packages/daemon/src/agent-runtime/workspace/process-owner.ts": 2,
  "packages/daemon/src/agent-runtime/workspace/runtime-context.ts": 1,
  "packages/daemon/src/agent-runtime/workspace/session-home.ts": 6,
  "packages/daemon/src/ssh-mesh.ts": 5,
  "packages/remi/src/conversation/parser.ts": 1,
  "packages/remi/src/core.ts": 1,
  "packages/server/src/api/helpers/uploads.ts": 1,
  "packages/server/src/config.ts": 1,
  "packages/server/src/session-archive/service.ts": 1,
  "packages/server/src/ssh-mesh/control-plane.ts": 2,
  "packages/server/src/worker/daemon.ts": 6,
  "packages/server/src/worker/local-skills.ts": 8,
  "packages/server/src/worker/progress-summarizer.ts": 3,
  "packages/shared/src/config.ts": 2,
  "packages/shared/src/db/index.ts": 1,
  "packages/shared/src/home-paths.ts": 1,
  "packages/shared/src/infra/config-manager.ts": 1,
  "packages/shared/src/logger.ts": 2,
};

function homeCallCount(file: string, text: string): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const homeNames = new Set(["homedir"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !["os", "node:os"].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const entry of bindings.elements) {
        if ((entry.propertyName ?? entry.name).text === "homedir") homeNames.add(entry.name.text);
      }
    }
  }
  let count = 0;
  function visit(node: ts.Node): void {
    if ((ts.isCallExpression(node) && ts.isIdentifier(node.expression) && homeNames.has(node.expression.text))
      || (ts.isPropertyAccessExpression(node) && node.name.text === "homedir")) count++;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

test("production home call sites do not grow without an isolation review", () => {
  const violations: string[] = [];
  for (const file of new Bun.Glob("packages/*/src/**/*.ts").scanSync({ cwd: ROOT })) {
    const count = homeCallCount(file, readFileSync(join(ROOT, file), "utf8"));
    const allowed = HOME_CALL_LIMITS[file] ?? 0;
    if (count > allowed) violations.push(`${file}: ${count} home reads (allowed ${allowed})`);
  }
  expect(violations, "Route new write defaults through an existing isolated path knob; review home reads").toEqual([]);
});
