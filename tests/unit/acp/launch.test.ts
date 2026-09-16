import { expect, it } from "bun:test";
import { resolveAcpProcessLaunch } from "@acp/launch.js";

it("launches the Claude Node wrapper with literal arguments on Windows", () => {
  const wrapper = "C:/Program Files/Remi/remi-claude-agent-acp";
  const launch = resolveAcpProcessLaunch(wrapper, ["--verify-patch"], "win32");
  expect(launch.executable).toBe(Bun.which("node") ?? "node");
  expect(launch.args).toEqual([wrapper, "--verify-patch"]);
  expect(resolveAcpProcessLaunch("codex.exe", ["--help"], "win32")).toEqual({ executable: "codex.exe", args: ["--help"] });
  expect(resolveAcpProcessLaunch(wrapper, [], "linux")).toEqual({ executable: wrapper, args: [] });
});
