import { runGitCredentialHelper } from "@daemon/agent-runtime/repo/credential-broker.js";

/** Internal Git credential-helper entry point. It must never log its response. */
export async function run(args: string[]): Promise<void> {
  const output = await runGitCredentialHelper(args[0] ?? "");
  if (output) process.stdout.write(output);
}
