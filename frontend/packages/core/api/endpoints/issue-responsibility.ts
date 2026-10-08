import { z } from "zod";
import type { HttpClient } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import { IssueResponsibilitySchema, IssueDeliverySchema, QuestionViewSchema, type QuestionView } from "../schemas/issue-responsibility";

export class IssueResponsibilityEndpoints {
  constructor(readonly http: HttpClient) {}
  async getIssueResponsibility(id: string) {
    const path = `/api/issues/${encodeURIComponent(id)}/responsibility`;
    return parseStrictResponse<z.infer<typeof IssueResponsibilitySchema>>(await this.http.fetch<unknown>(path), IssueResponsibilitySchema, { endpoint: path });
  }
  async listIssueDeliveries(id: string) {
    const path = `/api/issues/${encodeURIComponent(id)}/deliveries`;
    return parseStrictResponse<{ deliveries: z.infer<typeof IssueDeliverySchema>[] }>(await this.http.fetch<unknown>(path), z.object({ deliveries: z.array(IssueDeliverySchema) }), { endpoint: path }).deliveries;
  }
  async submitIssueDelivery(id: string, body: { summary: string; sessionId?: string; dedupeKey?: string }) {
    const path = `/api/issues/${encodeURIComponent(id)}/deliveries`;
    return parseStrictResponse<{ delivery: z.infer<typeof IssueDeliverySchema> }>(await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify(body) }), z.object({ delivery: IssueDeliverySchema }), { endpoint: path }).delivery;
  }
  async respondIssueDelivery(id: string, deliveryId: string, body: { action: "accept" | "return"; body?: string; revision: string }) {
    const path = `/api/issues/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/respond`;
    return parseStrictResponse<{ delivery: z.infer<typeof IssueDeliverySchema> }>(await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify(body) }), z.object({ delivery: IssueDeliverySchema }), { endpoint: path }).delivery;
  }
  async listIssueQuestions(id: string) {
    const path = `/api/issues/${encodeURIComponent(id)}/questions`;
    return parseStrictResponse<{ questions: QuestionView[] }>(await this.http.fetch<unknown>(path), z.object({ questions: z.array(QuestionViewSchema) }), { endpoint: path }).questions;
  }
  async authorizeIssueDelivery(id: string, deliveryId: string, body: { agentId: string | null; revision: string }) {
    const path = `/api/issues/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/authorize`;
    return parseStrictResponse<{ delivery: z.infer<typeof IssueDeliverySchema> }>(await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify(body) }), z.object({ delivery: IssueDeliverySchema }), { endpoint: path }).delivery;
  }
  async getQuestion(id: string) {
    const path = `/api/messages/${encodeURIComponent(id)}/question`;
    const question = parseStrictResponse<{ question: QuestionView }>(await this.http.fetch<unknown>(path), z.object({ question: QuestionViewSchema }), { endpoint: path }).question;
    if (question.id !== id) throw new ApiContractError(path, "Server returned a different question");
    return question;
  }
  async actOnQuestion(id: string, action: "answer" | "escalate" | "transfer" | "present" | "continue" | "close", body: { expected_route_revision: number; expected_answer_revision?: number; response?: Record<string, unknown>; body_md?: string; reason?: string; summary?: string; revise?: boolean }) {
    const path = `/api/messages/${encodeURIComponent(id)}/question/${action}`;
    const question = parseStrictResponse<{ question: QuestionView }>(await this.http.fetch<unknown>(path, { method: "POST", body: JSON.stringify(body) }), z.object({ question: QuestionViewSchema }), { endpoint: path }).question;
    if (question.id !== id) throw new ApiContractError(path, "Server returned a different question");
    return question;
  }
}
