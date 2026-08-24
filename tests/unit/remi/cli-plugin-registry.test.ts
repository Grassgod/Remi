import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

describe("dynamic plugin CLI Registry adapter", () => {
  it("attributes plugin commands in inventory/help and rejects builtin shadowing", async () => {
    const script = String.raw`
      const { cliCommandInventory, dispatch, registerPluginCliCommand } = await import("./apps/remi/cli/index.ts");
      const output = [];
      const errors = [];
      let received = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...parts) => output.push(parts.map(String).join(" "));
      console.error = (...parts) => errors.push(parts.map(String).join(" "));
      const added = registerPluginCliCommand(
        "fixture-plugin-command",
        "Fixture command",
        async () => ({ run: async (args) => { received = args; } }),
        false,
        { kind: "plugin", pluginId: "fixture-plugin", pluginVersion: "1.2.3" },
      );
      const blocked = registerPluginCliCommand(
        "agent",
        "Must not shadow builtin",
        async () => ({ run: async () => {} }),
        false,
        { kind: "plugin", pluginId: "fixture-plugin", pluginVersion: "1.2.3" },
      );
      await dispatch(["fixture-plugin-command", "alpha", "--flag"]);
      await dispatch(["fixture-plugin-command", "--help"]);
      const entry = cliCommandInventory().find((item) => item.path.join(" ") === "fixture-plugin-command");
      const builtin = cliCommandInventory().find((item) => item.path.join(" ") === "agent");
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write(JSON.stringify({ added, blocked, received, entry, builtin, output, errors }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MULTIREMI_"))),
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.added).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.received).toEqual(["alpha", "--flag"]);
    expect(result.entry).toMatchObject({
      id: "plugin-cli.fixture-plugin.fixture-plugin-command",
      source: { kind: "plugin", pluginId: "fixture-plugin", pluginVersion: "1.2.3" },
    });
    expect(result.builtin.source).toEqual({ kind: "builtin" });
    expect(result.output.join("\n")).toContain("Source: plugin fixture-plugin@1.2.3");
    expect(result.errors.join("\n")).toContain("conflicts with a built-in command");
  });
});
