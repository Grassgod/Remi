import { afterEach, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { validateCodexModelCatalog } from "@acp/model-catalog-validation.js";

const saved = { ...process.env };
const homes: string[] = [];
afterEach(() => {
  for (const key of ["REMI_CODEX_AGENT_ACP_EXECUTABLE", "CODEX_PATH", "OPENAI_API_KEY", "CODEX_API_KEY"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(body = "") {
  const home = mkdtempSync(join(tmpdir(), "catalog-decoder-"));
  homes.push(home);
  const executable = join(home, "bridge.cjs");
  writeFileSync(executable, `#!${Bun.which("node")}\nconst fs = require("node:fs");
    fs.writeFileSync("invocation.json", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
      home: process.env.CODEX_HOME, codex: process.env.CODEX_PATH, key: process.env.OPENAI_API_KEY,
      codexKey: process.env.CODEX_API_KEY, pid: process.pid }));
    ${body}\n`);
  chmodSync(executable, 0o755);
  process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE = executable;
  process.env.CODEX_PATH = "/fixture/provider-codex";
  process.env.OPENAI_API_KEY = "private-provider-key";
  process.env.CODEX_API_KEY = "private-codex-key";
  return { home, catalog: join(home, 'provider "catalog".json'), invocation: join(home, "invocation.json") };
}

it("uses the selected bridge and its Codex binding with literal TOML and an isolated home", async () => {
  const f = fixture();
  await validateCodexModelCatalog(f.catalog, f.home, new AbortController().signal);
  const call = JSON.parse(readFileSync(f.invocation, "utf8"));
  expect(call.args.slice(0, 4)).toEqual(["cli", "debug", "models", "-c"]);
  expect(parse(call.args[4])).toEqual({ model_catalog_json: f.catalog });
  expect(call).toMatchObject({ cwd: realpathSync(f.home), home: f.home, codex: "/fixture/provider-codex" });
  expect(call.key).toBeUndefined();
  expect(call.codexKey).toBeUndefined();
});

it("rejects decoder and spawn failures without exposing output, paths or error causes", async () => {
  const f = fixture('console.log("private-provider-key"); console.error("private-codex-key"); process.exit(1);');
  for (const executable of [process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE!, join(f.home, "private-provider-key")]) {
    process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE = executable;
    const error = await validateCodexModelCatalog(f.catalog, f.home, new AbortController().signal).catch(error => error);
    expect(error.message).toBe("Runtime codex model catalog validation failed");
    expect(error.cause).toBeUndefined();
  }
});

it("does not launch an already cancelled validation", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error("private-cancellation-reason"));
  await expect(validateCodexModelCatalog(f.catalog, f.home, controller.signal)).rejects.toThrow("Runtime codex model catalog validation failed");
  expect(existsSync(f.invocation)).toBe(false);
});

it("terminates a decoder that exceeds the validation deadline", async () => {
  const f = fixture("setInterval(() => {}, 1000);");
  await expect(validateCodexModelCatalog(f.catalog, f.home, new AbortController().signal)).rejects.toThrow("Runtime codex model catalog validation failed");
  const call = JSON.parse(readFileSync(f.invocation, "utf8"));
  expect(() => process.kill(call.pid, 0)).toThrow();
}, 15_000);

it("cancels the bridge and its native child without leaving a process behind", async () => {
  const f = fixture(`const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync("child.pid", String(child.pid)); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const validation = validateCodexModelCatalog(f.catalog, f.home, controller.signal);
  const childPidPath = join(f.home, "child.pid");
  for (let attempt = 0; attempt < 200 && !existsSync(childPidPath); attempt++) await Bun.sleep(10);
  controller.abort(new Error("private-cancellation-reason"));
  await expect(validation).rejects.toThrow("Runtime codex model catalog validation failed");
  expect(existsSync(childPidPath)).toBe(true);
  const pid = Number(readFileSync(childPidPath, "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 200 && alive; attempt++) {
    try { process.kill(pid, 0); await Bun.sleep(10); } catch { alive = false; }
  }
  expect(alive).toBe(false);
  const call = JSON.parse(readFileSync(f.invocation, "utf8"));
  expect(() => process.kill(call.pid, 0)).toThrow();
});
