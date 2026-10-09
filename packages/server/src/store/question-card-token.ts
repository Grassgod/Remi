import { createHash, randomBytes } from "node:crypto";

export interface QuestionCardCredential {
  token: string;
  operatorOpenId: string;
  routeRevision?: number;
}

export class QuestionCardTokenError extends Error {
  readonly status = 403;
  constructor(readonly code: "token_invalid" | "token_consumed" | "recipient_mismatch") {
    super(code);
  }
}

export function mintQuestionCardToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashQuestionCardToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function assertQuestionCardToken(
  row: { token_hash?: unknown; token_recipient?: unknown; token_consumed_at?: unknown; status?: unknown } | null,
  credential: QuestionCardCredential,
  pendingStatus: "pending" | "escalated",
): void {
  if (!row || !credential.token || row.token_hash !== hashQuestionCardToken(credential.token)) {
    throw new QuestionCardTokenError("token_invalid");
  }
  if (!credential.operatorOpenId || row.token_recipient !== credential.operatorOpenId) {
    throw new QuestionCardTokenError("recipient_mismatch");
  }
  if (row.token_consumed_at || row.status !== pendingStatus) {
    throw new QuestionCardTokenError("token_consumed");
  }
}
