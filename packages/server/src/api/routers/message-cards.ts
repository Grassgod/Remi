import type { Context, Hono } from "hono";
import type { RouterDeps } from "./deps.js";
import { currentAccessToken, cleanString } from "../wire/context.js";
import { daemonTaskRuntimeIdentityDenial } from "../helpers/auth-guards.js";
import { readJsonStrict, isJsonApiError } from "../helpers/request.js";
import { QuestionCardTokenError, assertQuestionCardToken } from "@multiremi/store/question-card-token.js";
import { IssueDecisionError } from "@multiremi/store/repos/issues-repo.js";
import { messageResponse } from "../helpers/conversations.js";

export function registerMessageCardRoutes(app: Hono, { store }: RouterDeps): void {
  const load = (c: Context) => {
    const token = currentAccessToken(c);
    if (token?.type !== "daemon" || !token.daemonId) return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
    const message = store.getMessage(c.req.param("id")!);
    if (!message || message.message_kind !== "decision") return c.json({ error: "decision not found" }, 404);
    const request = store.getTaskHumanRequest(message.id);
    const decision = store.getIssueDecisionAnywhere(message.id);
    const task = request ? store.getTask(request.taskId) : null;
    const workspaceId = task?.workspaceId ?? (decision ? store.getIssue(decision.issueId)?.workspaceId : null);
    if (!workspaceId || workspaceId !== token.workspaceId) return c.json({ error: "decision not found" }, 404);
    if (request) {
      const denied = daemonTaskRuntimeIdentityDenial(store, token, request.taskId, { feishuBotTransport: true, issueHumanRequestTransport: true });
      if (denied) return c.json(denied.body, denied.status);
    } else if (!decision || !store.canFeishuBotDaemonAccessIssueDecision(workspaceId, token.daemonId, decision.issueId)) {
      return c.json({ error: "forbidden for daemon identity", code: "daemon_identity_forbidden" }, 403);
    }
    return { message, request, decision, workspaceId };
  };
  app.get("/api/daemon/messages/:id", c => {
    const loaded = load(c);
    if (loaded instanceof Response) return loaded;
    c.header("Cache-Control", "no-store");
    return c.json({ message: messageResponse(loaded.message), request: loaded.request, decision: loaded.decision });
  });
  app.post("/api/daemon/messages/:id/card", async c => {
    const loaded = load(c);
    if (loaded instanceof Response) return loaded;
    const input = await readJsonStrict<{ recipient_open_id?: unknown }>(c);
    if (isJsonApiError(input)) return c.json({ error: input.apiError }, 400);
    if (!loaded.request) return c.json({ error: "card is delivered through the issue topic" }, 409);
    const card = store.prepareTaskStreamQuestionCard(loaded.message.id, typeof input.recipient_open_id === "string" ? input.recipient_open_id : "");
    if (!card) return c.json({ error: "card recipient or decision is invalid" }, 409);
    c.header("Cache-Control", "no-store");
    return c.json({ card });
  });
  app.post("/api/daemon/messages/:id/answer", async c => {
    const loaded = load(c);
    if (loaded instanceof Response) return loaded;
    const input = await readJsonStrict<{ answer?: unknown; response?: unknown; token?: unknown; operator_open_id?: unknown }>(c);
    if (isJsonApiError(input)) return c.json({ error: input.apiError }, 400);
    const credential = { token: typeof input.token === "string" ? input.token : "", operatorOpenId: typeof input.operator_open_id === "string" ? input.operator_open_id : "" };
    try {
      assertQuestionCardToken({ token_hash: loaded.message.card_token_hash, token_recipient: loaded.message.card_token_recipient,
        token_consumed_at: loaded.message.card_token_consumed_at, status: loaded.request?.status ?? loaded.decision?.status }, credential, loaded.request ? "pending" : "escalated");
    } catch (error) {
      if (error instanceof QuestionCardTokenError) return c.json({ error: error.message, code: error.code }, 403);
      throw error;
    }
    const config = store.getFeishuBotConfig(loaded.workspaceId);
    const operator = config ? store.resolveFeishuDecisionOperatorMember(loaded.workspaceId, config.appId, credential.operatorOpenId) : null;
    if (operator?.status !== "resolved") return c.json({ error: "card operator is not an active workspace member", code: operator?.status === "ambiguous" ? "decision_member_ambiguous" : "decision_member_unmapped" }, 403);
    const answer = typeof input.answer === "string" ? cleanString(input.answer) : null;
    const response = input.response && typeof input.response === "object" && !Array.isArray(input.response) ? input.response as Record<string, unknown> : undefined;
    if (loaded.request ? !response : !answer) return c.json({ error: loaded.request ? "response is required" : "answer is required" }, 400);
    try {
      const result = store.answerMessageDecision(loaded.message.id, { sender: { type: "member", id: operator.member.id },
        body_md: answer ?? JSON.stringify(response), response, credential });
      return c.json({ ...result, message: messageResponse(result.message), request: store.getTaskHumanRequest(loaded.message.id), decision: store.getIssueDecisionAnywhere(loaded.message.id) });
    } catch (error) {
      if (error instanceof QuestionCardTokenError) return c.json({ error: error.message, code: error.code }, 403);
      if (error instanceof IssueDecisionError) {
        if (store.getIssueDecisionAnywhere(loaded.message.id)?.status === "withdrawn") return c.json({ error: error.message, code: "token_consumed" }, 403);
        return c.json({ error: error.message, code: (error as IssueDecisionError & { code?: string }).code }, error.status);
      }
      if (error instanceof Error && error.message === "Decision card context not found") return c.json({ error: error.message }, 404);
      if (error instanceof Error && /settled/.test(error.message)) return c.json({ error: error.message, code: "token_consumed" }, 403);
      throw error;
    }
  });
}
