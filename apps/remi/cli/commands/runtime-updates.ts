import type { CommandSpec } from "../core/command-registry.js";
import { activeRuntimeSelection, configureRuntimeUpdates, runtimeUpdateSettings, runtimeUpdateStatus, selectedRuntimeVersions } from "@acp/runtime-update-state.js";
import { latestRuntimeVersions } from "@acp/runtime-latest.js";

export function runtimeUpdateCommandSpecs(): CommandSpec[] {
  return [
    {
      id: "runtime.updates.status", path: ["runtime", "updates", "status"],
      description: "Show this machine's dependency auto-update policy, versions and last check", mutation: "read",
      run: async () => console.log(JSON.stringify({
        settings: runtimeUpdateSettings(), lastCheck: runtimeUpdateStatus(), active: activeRuntimeSelection(),
        selected: { claude: selectedRuntimeVersions("claude"), codex: selectedRuntimeVersions("codex") },
      }, null, 2)),
    },
    {
      id: "runtime.updates.configure", path: ["runtime", "updates", "configure"],
      description: "Configure local stable ACP and Agent runtime automatic updates", mutation: "write",
      options: [
        { name: "enabled", type: "string", valueName: "true|false", description: "Enable or disable automatic dependency updates" },
        { name: "interval-hours", type: "integer", valueName: "1..720", description: "Hours between stable-version checks (default 24)" },
      ],
      run: async ({ options }) => {
        if (options.enabled !== undefined && options.enabled !== "true" && options.enabled !== "false") throw new Error("--enabled must be true or false");
        console.log(JSON.stringify(configureRuntimeUpdates({
          ...(options.enabled === undefined ? {} : { enabled: options.enabled === "true" }),
          ...(options["interval-hours"] === undefined ? {} : { intervalHours: Number(options["interval-hours"]) }),
        })));
      },
    },
    {
      id: "runtime.updates.check", path: ["runtime", "updates", "check"],
      description: "Check npm's latest stable ACP, Claude SDK/Code and Codex versions without installing", mutation: "read",
      run: async () => console.log(JSON.stringify({ latest: await latestRuntimeVersions(["claude", "codex"]) }, null, 2)),
    },
  ];
}
