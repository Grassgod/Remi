import { expect, it } from "bun:test";
import { twoProcessChildEnv } from "../../helpers/two-process.js";
import { HERMETIC_ENV_RUN_ROOT_PATHS } from "../../setup/hermetic-env-policy.js";

it("forwards isolated path knobs and test inputs through the API child environment", () => {
  const env = twoProcessChildEnv();
  const names = [...Object.keys(HERMETIC_ENV_RUN_ROOT_PATHS), "MULTIREMI_TEST_RUN_ROOT", "NODE_ENV"];
  const child = Bun.spawnSync([process.execPath, "-e",
    `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name]]))))`,
  ], { env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const received = JSON.parse(new TextDecoder().decode(child.stdout));
  for (const name of names) expect(received[name], name).toBe(process.env[name]);
  expect(env.MULTIREMI_TOKEN).toBeUndefined();
});
