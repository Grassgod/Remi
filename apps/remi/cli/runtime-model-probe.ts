import { AcpProvider, type AcpProviderOptions } from "@acp/index.js";

/** Private subprocess entry; never sends a model prompt or opens the Remi database. */
export async function run(args: string[]): Promise<void> {
  if (args.length) throw new Error("runtime-model-probe accepts stdin only");
  const input = await Bun.stdin.text();
  if (input.length > 1024 * 1024) throw new Error("Runtime model probe input too large");
  const options = JSON.parse(input) as AcpProviderOptions;
  if (options.agentType !== "claude" && options.agentType !== "codex") {
    throw new Error("Unsupported runtime model provider");
  }
  const provider = new AcpProvider({ ...options, inheritProcessGroup: true });
  try {
    const models = await provider.discoverModelCapabilities();
    await provider.close();
    process.stdout.write(JSON.stringify(models));
  } catch {
    // Raw ACP errors may echo credentials. The parent reports only exit status.
    process.stderr.write("Runtime model capability discovery failed\n");
    process.exitCode = 1;
  } finally {
    await provider.close();
  }
}
