import { parseRuntimeConnectionProfile, type RuntimeConnectionProfile } from "./runtime-connection.js";
export type {
  RuntimeConnectionProfile as RuntimeCodexProfile,
  RuntimeConnectionProfileConfig as RuntimeCodexProfileConfig,
  RuntimeConnectionProfileInput as RuntimeCodexProfileInput,
} from "./runtime-connection.js";

export function parseRuntimeCodexProfile(value: unknown): RuntimeConnectionProfile | null {
  return parseRuntimeConnectionProfile(value, "REMI_CODEX_");
}
