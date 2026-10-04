import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function larkCliTestEnv(
  inherited: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): NodeJS.ProcessEnv {
  const configDir = inherited.LARKSUITE_CLI_CONFIG_DIR || join(home, ".lark-cli");
  if (existsSync(join(configDir, "config.json"))) return { ...inherited };

  const runRoot = inherited.MULTIREMI_TEST_RUN_ROOT;
  if (!runRoot) throw new Error("lark-cli test isolation requires the hermetic preload");
  // Even a signed-out health probe creates CLI metadata caches.
  const root = join(runRoot, "lark-cli");
  return {
    ...inherited,
    LARKSUITE_CLI_CONFIG_DIR: join(root, "config"),
    LARKSUITE_CLI_DATA_DIR: join(root, "data"),
    LARKSUITE_CLI_LOG_DIR: join(root, "logs"),
  };
}
