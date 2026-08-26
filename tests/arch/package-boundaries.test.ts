import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TokenEntry as SdkTokenEntry, TokenStatus as SdkTokenStatus } from "@remi/plugin-sdk";
import type { TokenEntry as AuthTokenEntry, TokenStatus as AuthTokenStatus } from "@auth/types.js";

const CONTRACTS_SRC = join(import.meta.dir, "../../packages/contracts/src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Match import/export ... from "<spec>" and dynamic import("<spec>")
const SPECIFIER_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

describe("packages/contracts boundaries", () => {
  const files = listTsFiles(CONTRACTS_SRC);

  test("contracts stays pure: no runtime/env dependencies and no escaping relative imports", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");

      expect(src, `${file} must not import from "bun`).not.toContain('from "bun');
      expect(src, `${file} must not import from "bun:`).not.toContain('from "bun:');
      expect(src, `${file} must not import from "node:`).not.toContain('from "node:');
      expect(src, `${file} must not reference process.`).not.toContain("process.");

      for (const match of src.matchAll(SPECIFIER_RE)) {
        const spec = match[1];
        if (spec.startsWith(".")) {
          expect(spec, `${file} relative import must not escape packages/contracts/src: ${spec}`).not.toContain("../");
        }
      }
    }
  });

  test("contracts has no back-dependency on application src/", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(SPECIFIER_RE)) {
        const spec = match[1];
        expect(spec, `${file} must not import from src/: ${spec}`).not.toContain("src/");
      }
    }
  });
});

// ── No package may depend back on the application core (src/remi, src/multiremi) ──
const PACKAGES_ROOT = join(import.meta.dir, "../../packages");
const BOUNDED_PACKAGES = [
  "queue",
  "daemon",
  "shared",
  "acp",
  "memory",
  "auth",
  "connectors",
  "contracts",
  "server",
];

/**
 * The application-core alias a package may use to address ITSELF.
 *
 * tsconfig maps `@multiremi/*` → packages/server/src/*, so packages/server's own
 * intra-package imports (`@multiremi/store/store.js`) wear the same prefix that
 * marks an illegal back-edge for every other package. Only the owner is exempt.
 */
const SELF_CORE_ALIAS: Record<string, string> = { server: "@multiremi/" };

/** True if a module specifier reaches into src/remi or src/multiremi. */
function isCoreBackEdge(spec: string, pkg?: string): boolean {
  // Allowed real-package aliases that merely share the @remi/@multiremi prefix.
  if (spec === "@remi/plugin-sdk" || spec.startsWith("@remi/plugin-sdk/")) return false;
  if (spec === "@multiremi/contracts" || spec.startsWith("@multiremi/contracts/")) return false;

  // A package addressing itself through its own alias is not a back-edge.
  const selfAlias = pkg ? SELF_CORE_ALIAS[pkg] : undefined;
  if (selfAlias && spec.startsWith(selfAlias)) return false;

  // Alias forms that resolve to src/remi/* or src/multiremi/*.
  if (spec === "@remi" || spec.startsWith("@remi/")) return true;
  if (spec === "@multiremi" || spec.startsWith("@multiremi/")) return true;

  // Relative forms that escape into the application core.
  if (spec.includes("src/remi/") || spec.includes("src/multiremi/")) return true;

  return false;
}

describe("packages/* have no back-edge into application core", () => {
  for (const pkg of BOUNDED_PACKAGES) {
    test(`packages/${pkg}/src does not import from src/remi or src/multiremi`, () => {
      const files = listTsFiles(join(PACKAGES_ROOT, pkg, "src"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        for (const match of src.matchAll(SPECIFIER_RE)) {
          const spec = match[1];
          expect(
            isCoreBackEdge(spec, pkg),
            `packages/${pkg} must not import application core: ${spec} (in ${file})`,
          ).toBe(false);
        }
      }
    });
  }
});

// ── packages/server's declared workspace-dependency set ──────────────────────
//
// packages/server is the multiremi application core: the HTTP API (api/routers,
// api/wire), the Postgres/SQLite store (store/repos), the worker and the relay.
// Being the top of the dependency graph it is exempt from the back-edge rule
// above for its own alias, so without an explicit allowlist nothing constrains
// what it pulls in. This is that allowlist — the set derived from its imports as
// they stand today.
//
// Scope: tsconfig workspace aliases only. npm packages (hono, croner, smol-toml)
// and node: builtins are dependency-manifest concerns, not layering ones.

/** Every tsconfig `paths` alias prefix. Longest match wins, so order is free. */
const WORKSPACE_ALIAS_PREFIXES = [
  "@remi/plugin-sdk",
  "@multiremi/contracts",
  "@shared/contracts/",
  "@shared/",
  "@acp/",
  "@memory/",
  "@queue/",
  "@connectors/",
  "@auth/",
  "@daemon/",
  "@remi/",
  "@multiremi/",
];

/** The alias prefix a specifier resolves through, or null if it is not aliased. */
function aliasPrefixOf(spec: string): string | null {
  let best: string | null = null;
  for (const prefix of WORKSPACE_ALIAS_PREFIXES) {
    if (!spec.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best;
}

/**
 * The alias prefixes packages/server/src is allowed to import through.
 *
 *   @multiremi/           itself (tsconfig maps it to packages/server/src)
 *   @multiremi/contracts  the shared protocol/type package
 *   @shared/              logger, db bridge, version
 *   @shared/contracts/    the same contracts package under its @shared alias
 *   @acp/                 ACP client, used by the worker
 *   @daemon/              agent-runtime (session, repo checkout, skills, prompts)
 *   @connectors/          outbound notification adapters (Feishu)
 *
 * Notably absent and expected to stay absent: @remi/ (the other product core),
 * @memory/, @queue/, @auth/.
 */
const SERVER_ALLOWED_ALIASES = new Set([
  "@multiremi/",
  "@multiremi/contracts",
  "@shared/",
  "@shared/contracts/",
  "@acp/",
  "@daemon/",
  "@connectors/",
]);

describe("packages/server dependency set", () => {
  test("imports only its declared workspace aliases", () => {
    const files = listTsFiles(join(PACKAGES_ROOT, "server", "src"));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(SPECIFIER_RE)) {
        const prefix = aliasPrefixOf(match[1]);
        if (prefix === null) continue;
        used.add(prefix);
        if (!SERVER_ALLOWED_ALIASES.has(prefix)) violations.push(`${match[1]} (in ${file})`);
      }
    }

    expect(violations).toEqual([]);
    // The allowlist must not rot into permission for packages nobody imports.
    expect([...used].sort()).toEqual([...SERVER_ALLOWED_ALIASES].sort());
  });

  test("keeps relative imports inside packages/server/src", () => {
    const files = listTsFiles(join(PACKAGES_ROOT, "server", "src"));
    const root = join(PACKAGES_ROOT, "server", "src");
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(SPECIFIER_RE)) {
        const spec = match[1];
        if (!spec.startsWith(".")) continue;
        const resolved = join(file, "..", spec);
        expect(resolved.startsWith(root), `${file} relative import escapes packages/server/src: ${spec}`).toBe(true);
      }
    }
  });
});

// ── @remi/plugin-sdk mirrors packages/auth's token types ─────────────────────

describe("@remi/plugin-sdk auth mirror", () => {
  test("TokenEntry/TokenStatus stay structurally assignable to packages/auth", () => {
    // plugin-sdk restates these shapes instead of importing packages/auth so the
    // SDK stays dependency-free (see packages/plugin-sdk/src/index.ts). These
    // probes are erased at runtime — they fail `tsc --noEmit` the moment either
    // side drifts, in either direction.
    const sdkEntryAsAuth: AuthTokenEntry = {} as SdkTokenEntry;
    const authEntryAsSdk: SdkTokenEntry = {} as AuthTokenEntry;
    const sdkStatusAsAuth: AuthTokenStatus = {} as SdkTokenStatus;
    const authStatusAsSdk: SdkTokenStatus = {} as AuthTokenStatus;

    expect([sdkEntryAsAuth, authEntryAsSdk, sdkStatusAsAuth, authStatusAsSdk]).toHaveLength(4);
  });
});
