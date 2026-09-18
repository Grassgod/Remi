import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const mode = process.env.FAKE_AGY_MODE ?? "stream";
const session = (!mode.endsWith("wrong-session") && value("--conversation")) || "12345678-1234-1234-1234-123456789abc";
const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
if (args.includes("--version")) {
  process.stdout.write("1.2.2\n");
} else if (args.includes("--help")) {
  process.stdout.write(mode.startsWith("legacy") ? "-p --log-file --print-timeout\n" : "--output-format --input-format --effort\n");
} else if (args.includes("models")) {
  process.stdout.write(mode === "auth-error" ? "Fetching available models...\nError: Please sign in\n" : "model-one\tModel One\nmodel-two\tModel Two\n");
  if (mode === "auth-error") process.exitCode = 1;
} else {
  let prompt = value("-p");
  if (args.includes("--input-format")) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    prompt = JSON.parse(input.trim()).message.content;
  }
  if (process.env.FAKE_AGY_CAPTURE) writeFileSync(process.env.FAKE_AGY_CAPTURE, JSON.stringify({ args, prompt, cwd: process.cwd(), token: process.env.MULTIREMI_TOKEN, contextDir: process.env.MULTIREMI_ANTIGRAVITY_CONTEXT_DIR }));
  const dataDir = process.env.FAKE_AGY_DATA_DIR ?? process.cwd();
  let log = `CLI app data directory: ${dataDir}\nPrint mode: conversation=${session}, sending message\n`;
  if (mode === "legacy-timeout") log += "Print mode: timed out after 100 polls\n";
  if (mode === "legacy-error") log += "agent executor error: provider rejected the request\n";
  writeFileSync(value("--log-file"), log);
  if (mode === "hang") {
    emit({ event: "init", conversation_id: session });
    setInterval(() => {}, 1000);
  } else if (mode.startsWith("legacy")) {
    if (mode === "legacy-text" || mode === "legacy-wrong-session") process.stdout.write("# Heading\n\n- First\n- Second\n");
    if (mode === "legacy-recovery") {
      const file = join(dataDir, "brain", session, ".system_generated", "logs", "transcript.jsonl");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, [
        { type: "USER_INPUT", content: "old" },
        { type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Old answer" },
        { type: "USER_INPUT", content: prompt },
        { type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: "Recovered current answer" },
      ].map(row => JSON.stringify(row)).join("\n"));
    }
  } else if (mode === "invalid-json") {
    process.stdout.write("not a JSON event\n");
  } else {
    emit({ event: "init", conversation_id: session });
    if (mode === "tool") {
      emit({ event: "step_update", step_update: { step_type: "tool", step_index: 1, state: "ACTIVE", tool_name: "run_command", tool_info: { parameters: { CommandLine: "echo test" } } } });
      emit({ event: "step_update", step_update: { step_type: "tool", step_index: 1, state: "DONE", tool_name: "run_command", tool_info: { output: "test\n" } } });
    }
    for (const text_delta of ["# Heading\n", "\n- Done\n"]) emit({ event: "step_update", step_update: { step_type: "agent_response", step_index: 2, state: "ACTIVE", text_delta } });
    if (mode !== "missing-result") emit({ event: "result", result: { conversation_id: session, status: mode === "result-error" ? "ERROR" : "SUCCESS", error: mode === "result-error" ? "model request failed" : undefined, response: "# Heading\n\n- Done\n", usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 10, total_tokens: 120 } } });
  }
}
