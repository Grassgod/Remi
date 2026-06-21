import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MultiremiCliConfig {
  server_url?: string;
  workspace_id?: string;
  token?: string;
  provider?: string;
  runtime_id?: string;
  runtime_name?: string;
  daemon_id?: string;
}

export function multiremiConfigPath(): string {
  return process.env.MULTIREMI_CONFIG ?? join(homedir(), ".multiremi", "config.json");
}

export function loadMultiremiConfig(path = multiremiConfigPath()): MultiremiCliConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as MultiremiCliConfig;
}

export function saveMultiremiConfig(config: MultiremiCliConfig, path = multiremiConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function redactMultiremiConfig(config: MultiremiCliConfig): MultiremiCliConfig {
  return { ...config, token: config.token ? "***" : undefined };
}
