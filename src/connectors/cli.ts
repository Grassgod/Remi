/**
 * Local CLI REPL connector for development and testing.
 */

import type { AgentResponse } from "../providers/base.js";
import type { Connector, MessageHandler, IncomingMessage } from "./base.js";
import { createInterface } from "node:readline";

const CLI_CHAT_ID = "cli";
const CLI_SENDER = "user";

export class CLIConnector implements Connector {
  private _running = false;

  get name(): string {
    return "cli";
  }

  async start(handler: MessageHandler): Promise<void> {
    this._running = true;

    console.log("Remi AI Assistant (type 'exit' or Ctrl+C to quit)");
    console.log("-".repeat(48));

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): Promise<string | null> => {
      return new Promise((resolve) => {
        rl.question("\nYou: ", (answer) => {
          resolve(answer);
        });
        rl.once("close", () => resolve(null));
      });
    };

    while (this._running) {
      let line: string | null;
      try {
        line = await prompt();
      } catch {
        console.log("\nBye!");
        break;
      }

      if (line === null || ["exit", "quit"].includes(line.trim().toLowerCase())) {
        console.log("Bye!");
        break;
      }

      const text = line.trim();
      if (!text) continue;

      const msg: IncomingMessage = {
        text,
        chatId: CLI_CHAT_ID,
        sender: CLI_SENDER,
        connectorName: this.name,
      };

      const response = await handler(msg);
      await this.reply(CLI_CHAT_ID, response);
    }

    rl.close();
  }

  async stop(): Promise<void> {
    this._running = false;
  }

  async reply(_chatId: string, response: AgentResponse): Promise<void> {
    console.log(`\nRemi: ${response.text}`);
    if (response.costUsd != null) {
      const parts = [`cost: $${response.costUsd.toFixed(4)}`];
      if (response.inputTokens != null) {
        parts.push(`input: ${response.inputTokens} tokens`);
      }
      if (response.outputTokens != null) {
        parts.push(`output: ${response.outputTokens} tokens`);
      }
      if (response.durationMs != null) {
        const totalS = response.durationMs / 1000;
        if (totalS < 60) {
          parts.push(`time: ${totalS.toFixed(1)}s`);
        } else if (totalS < 3600) {
          const m = Math.floor(totalS / 60);
          const s = Math.floor(totalS % 60);
          parts.push(`time: ${m}m${s}s`);
        } else {
          const h = Math.floor(totalS / 3600);
          const rem = Math.floor(totalS % 3600);
          const m = Math.floor(rem / 60);
          const s = rem % 60;
          parts.push(`time: ${h}h${m}m${s}s`);
        }
      }
      process.stderr.write(`  [${parts.join(" | ")}]\n`);
    }
  }
}
