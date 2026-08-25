import { afterEach, describe, expect, it } from "bun:test";
import {
  generateIssueTitle,
  IssueTitleGatewayUnconfiguredError,
  parseIssueTitleResponse,
} from "@multiremi/issue-title/client.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const CODEX_FRAGMENT = [
  'model_provider = "OpenAI"',
  "[model_providers.OpenAI]",
  'base_url = "https://gateway.example.com/v1"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
].join("\n");

describe("Issue title model client", () => {
  it("parses fenced JSON and removes wrapping quotes", () => {
    expect(parseIssueTitleResponse('```json\n{"title":"“修复 Issue 自动命名”","keep":false}\n```')).toEqual({
      title: "修复 Issue 自动命名",
      keep: false,
    });
  });

  it("rejects overlong, multiline, and garbage output", () => {
    expect(() => parseIssueTitleResponse(JSON.stringify({ title: "超".repeat(41), keep: false }))).toThrow();
    expect(() => parseIssueTitleResponse(JSON.stringify({ title: "第一行\n第二行", keep: false }))).toThrow();
    expect(() => parseIssueTitleResponse("not-json")).toThrow();
    expect(() => parseIssueTitleResponse('{"title":"合法标题"}')).toThrow();
  });

  it("uses the configured Luna model through the Codex relay", async () => {
    const store = createLocalStore();
    store.updateWorkspace("local", { settings: { issue_auto_title: { enabled: true, model: "gpt-custom-luna" } } });
    store.upsertRelayConfig("local", "codex", {
      fragment: CODEX_FRAGMENT,
      tokenOp: "set",
      authToken: "secret-not-for-output",
    });
    const issue = store.createIssue({
      title: "Remi",
      description: "实现稳定的一键 Issue 自动命名功能，并且模型失败时不影响主流程。",
    });
    const request = { url: "", init: null as RequestInit | null };
    const result = await generateIssueTitle(store, {
      issue,
      httpRequest: async (url, init) => {
        request.url = url;
        request.init = init;
        return {
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"title":"实现 Issue 自动命名","keep":false}' } }] }),
        };
      },
    });

    expect(result).toEqual({ title: "实现 Issue 自动命名", keep: false, model: "gpt-custom-luna" });
    expect(request.url).toBe("https://gateway.example.com/v1/chat/completions");
    expect(JSON.parse(String(request.init?.body)).model).toBe("gpt-custom-luna");
  });

  it("falls back to a configured Claude relay when Codex is absent", async () => {
    const store = createLocalStore();
    store.upsertRelayConfig("local", "claude", {
      fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://claude.example.com" } }),
      tokenOp: "set",
      authToken: "secret-not-for-output",
    });
    const issue = store.createIssue({ title: "Remi", description: "这是一个足够长的 Issue 描述，用于验证 Claude 网关回落行为。" });
    let url = "";
    const result = await generateIssueTitle(store, {
      issue,
      httpRequest: async (requestUrl) => {
        url = requestUrl;
        return { status: 200, text: JSON.stringify({ content: [{ type: "text", text: '{"title":"验证 Claude 网关回落","keep":false}' }] }) };
      },
    });
    expect(url).toBe("https://claude.example.com/v1/messages");
    expect(result.title).toBe("验证 Claude 网关回落");
  });

  it("reports an unconfigured gateway before attempting transport", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Remi", description: "这是一个足够长的描述，用于验证未配置网关时的失败原因。" });
    await expect(generateIssueTitle(store, { issue })).rejects.toBeInstanceOf(IssueTitleGatewayUnconfiguredError);
  });
});
