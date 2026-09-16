import { basename } from "node:path";

/** Windows cannot execute the shipped extensionless Node wrapper directly. */
export function resolveAcpProcessLaunch(executable: string, args: string[] = [], platform: NodeJS.Platform = process.platform): { executable: string; args: string[] } {
  if (platform === "win32" && basename(executable) === "remi-claude-agent-acp") {
    return { executable: Bun.which("node") ?? "node", args: [executable, ...args] };
  }
  return { executable, args };
}
