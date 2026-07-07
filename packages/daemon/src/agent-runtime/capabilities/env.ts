import type { CapabilityBlock, EphemeralContext } from "../types.js";
import { buildTaskEnv } from "../env/injector.js";

export const envBlock: CapabilityBlock = {
  name: "env",

  ephemeral(ctx: EphemeralContext) {
    const { task, daemonOptions } = ctx;
    return {
      env: buildTaskEnv(task, {
        daemonPort: daemonOptions.daemonPort,
        serverUrl: daemonOptions.serverUrl,
        fallbackToken: daemonOptions.fallbackToken,
      }),
    };
  },
};
