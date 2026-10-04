import type { MultiremiIssueDecision, MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import {
  registerTaskInteraction,
  registerIssueDecisionCardInteraction,
  registerQuestionCardClient,
  type CardPatchMetadata,
  type QuestionCardCredential,
} from "@connectors/feishu/task-interaction.js";

const cleanups = new Set<() => void>();
export function resetQuestionCardHostFixtures(): void {
  for (const dispose of cleanups) dispose();
  cleanups.clear();
}

function cleanup(...disposers: (() => void)[]): () => void {
  const dispose = () => { disposers.forEach(stop => stop()); cleanups.delete(dispose); };
  cleanups.add(dispose);
  return dispose;
}

export function registerIssueDecisionCardFixture(entry: CardPatchMetadata & {
  chatId: string; recipientOpenId: string;
  getDecision: () => Promise<MultiremiIssueDecision | null>;
  submit: (answer: string, operatorOpenId: string, token: string) => Promise<MultiremiIssueDecision>;
}) {
  const patch = registerIssueDecisionCardInteraction({ appId: entry.appId, messageId: entry.messageId,
    agentName: entry.agentName, sessionId: entry.sessionId });
  const stop = registerQuestionCardClient(entry.appId, {
    getRequest: async () => null, respond: async () => { throw new Error("not a task fixture"); },
    getDecision: entry.getDecision,
    answer: (_decisionId, answer, credential) => entry.submit(answer, credential.operatorOpenId, credential.token),
  });
  return { dispose: cleanup(patch.dispose, stop) };
}

export function registerTaskInteractionFixture(entry: CardPatchMetadata & {
  chatId: string; recipientOpenId?: string; request: MultiremiTaskHumanRequest;
  submit: (response: Record<string, unknown>, credential: QuestionCardCredential) => Promise<MultiremiTaskHumanRequest>;
}) {
  const patch = registerTaskInteraction({ appId: entry.appId, messageId: entry.messageId,
    agentName: entry.agentName, sessionId: entry.sessionId });
  let consumed = false;
  const stop = registerQuestionCardClient(entry.appId, {
    getRequest: async () => patch.current() ?? entry.request,
    respond: async (_requestId, response, credential) => {
      if (credential.operatorOpenId !== entry.recipientOpenId) throw Object.assign(new Error("recipient_mismatch"), { code: "recipient_mismatch" });
      if (credential.token !== "card-token-fixture") throw Object.assign(new Error("token_invalid"), { code: "token_invalid" });
      if (consumed) throw Object.assign(new Error("token_consumed"), { code: "token_consumed" });
      consumed = true;
      try { return await entry.submit(response, credential); }
      catch (error) { consumed = false; throw error; }
    },
    getDecision: async () => null, answer: async () => { throw new Error("not a decision fixture"); },
  });
  return { current: patch.current, dispose: cleanup(patch.dispose, stop) };
}
