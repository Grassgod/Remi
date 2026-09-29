import { spawn } from "node:child_process";

const env = { ...process.env };
delete env.MULTIREMI_TOKEN;
delete env.MULTIREMI_TEST_POSTGRES_URL;
if (process.argv[2] === "postgres") {
  const connection = new URL(["postgresql:", "", "127.0.0.1"].join("/"));
  connection.port = "55433";
  connection.username = "mul395";
  connection.pathname = "/postgres";
  env.MULTIREMI_TEST_POSTGRES_URL = connection.href;
}
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /TOKEN|PASSWORD|SECRET|API_KEY/.test(key) && value && value.length > 8)
  .map(([, value]) => value!);
const redact = (line: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"),
  line.replace(/(?:postgres(?:ql)?|redis):\/\/\S+/g, "[connection]"));
const files = process.argv.slice(3);
const child = spawn("nice", ["-n", "15", "bun", "test", ...(files.length ? files : ["tests/unit/multiremi/"]), "--timeout", "20000"], {
  env, stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      process.stdout.write(`${redact(buffer.slice(0, end))}\n`);
      buffer = buffer.slice(end + 1);
    }
  });
  stream.on("end", () => { if (buffer) process.stdout.write(redact(buffer)); });
}
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});
