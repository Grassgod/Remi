import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { RelayEngine } from "@multiremi/core/api";

/**
 * Re-indent a stored gateway fragment for the editor.
 *
 * The server keeps a fragment byte-for-byte, so one written by a script or the
 * CLI can arrive as a single line. Claude and Antigravity fragments are JSON and
 * re-indent losslessly. The daemon already parses the Codex TOML and serializes
 * it with the same library before writing config.toml, so the normalized text is
 * what actually takes effect. Text that does not parse is returned untouched so
 * the editor still shows exactly what is stored.
 */
export function formatRelayFragment(engine: RelayEngine, fragment: string): string {
  const trimmed = fragment.trim();
  if (!trimmed) return fragment;
  try {
    if (engine === "codex") return stringifyToml(parseToml(trimmed)).trimEnd();
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return fragment;
  }
}
