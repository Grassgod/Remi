import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../api";
import { chatKeys } from "./queries";

// ─── Types ───────────────────────────────────────────────────────────────
//
// Native permission and AskUserQuestion payloads feed the persistent Q view.
// A worker may still be waiting or may have ended its provider call; answering
// alone does not prove consumption. The Q projection owns that state.

export type TaskHumanRequestKind = "permission" | "question";
export type TaskHumanRequestStatus = "pending" | "responded" | "timeout" | "cancelled";

export interface HumanRequestPermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

export interface HumanRequestQuestion {
  fieldKey: string;
  /** Present when the agent accepts a free-text answer besides the options. */
  otherFieldKey?: string;
  question: {
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  };
}

export interface TaskHumanRequest {
  id: string;
  taskId: string;
  sessionId?: string;
  kind: TaskHumanRequestKind;
  payload: {
    tool_call?: { title?: string } | null;
    options?: HumanRequestPermissionOption[];
    message?: string;
    questions?: HumanRequestQuestion[];
    context?: {
      text: string;
      truncated?: boolean;
    };
  };
  status: TaskHumanRequestStatus;
  response: Record<string, unknown> | null;
  respondedBy: string | null;
  createdAt: string;
  respondedAt: string | null;
}

const permissionOptionSchema = z.object({
  optionId: z.string(),
  kind: z.string(),
  name: z.string(),
});

const questionPayloadSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).default([]),
  multiSelect: z.boolean().optional(),
});
const questionSchema = z.union([z.object({
  fieldKey: z.string(),
  otherFieldKey: z.string().optional(),
  question: questionPayloadSchema,
}), questionPayloadSchema.transform(question => ({
  // SDK direct AUQ accepts a custom answer without an ACP other-field key.
  // These keys belong only to the form projection; the original Q stays intact.
  fieldKey: question.question, otherFieldKey: `${question.question}__other`, question,
}))]);

const questionContextSchema = z
  .object({
    text: z.string(),
    truncated: z.boolean().optional(),
  })
  .optional()
  .catch(undefined);

const humanRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sessionId: z.string().optional(),
  kind: z.enum(["permission", "question"]),
  payload: z
    .object({
      tool_call: z.object({ title: z.string().optional() }).nullish(),
      options: z.array(permissionOptionSchema).optional(),
      message: z.string().optional(),
      questions: z.array(questionSchema).optional(),
      context: questionContextSchema,
    })
    .loose(),
  status: z.enum(["pending", "responded", "timeout", "cancelled"]),
  response: z.record(z.string(), z.unknown()).nullable(),
  respondedBy: z.string().nullable(),
  createdAt: z.string(),
  respondedAt: z.string().nullable(),
});


/**
 * A native question's `payload.options` are its decision message's flattened
 * choices (`{label, value}`, written by the daemon's `turn.decision`); the
 * answers come from `payload.questions`. Only a permission request carries
 * permission options, so only there may they reject the request.
 */
function withoutQuestionChoices(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as { kind?: unknown; payload?: unknown };
  if (record.kind !== "question" || !record.payload || typeof record.payload !== "object") return value;
  const { options: _choices, ...payload } = record.payload as Record<string, unknown>;
  return { ...record, payload };
}

export function parseTaskHumanRequest(value: unknown): TaskHumanRequest | null {
  const parsed = humanRequestSchema.safeParse(withoutQuestionChoices(value));
  return parsed.success ? parsed.data as TaskHumanRequest : null;
}

// ─── Queries ─────────────────────────────────────────────────────────────

export interface HumanRequestsScope {
  /** The in-flight turn: its permissions and questions, answered ones included. */
  turnId?: string | null;
  /**
   * Also every question of the session still waiting for an answer, whatever
   * turn asked it. A Chat reads this so its own open Q stays answerable when
   * there is no in-flight turn, or not the one that asked.
   */
  open?: boolean;
}

/**
 * The permission and AskUserQuestion requests of one conversation. The key sits
 * under the Q key space (`["question", wsId]`): a new Q (`decision:created`) and
 * a resumed turn invalidate that prefix, so the list follows Qs the daemon
 * creates mid-turn without a task event of its own.
 */
export function humanRequestsOptions(wsId: string, sessionId: string | null | undefined, { turnId = null, open = false }: HumanRequestsScope = {}) {
  return queryOptions({
    queryKey: ["question", wsId, "requests", sessionId ?? "", turnId ?? "", open ? "open" : "turn"] as const,
    queryFn: async (): Promise<TaskHumanRequest[]> => {
      if (!sessionId) return [];
      const messages: Awaited<ReturnType<typeof api.listMessages>>["messages"] = [];
      let cursor: string | undefined;
      do {
        const page = await api.listMessages(sessionId, { message_kind: "decision", cursor });
        messages.push(...page.messages); cursor = page.next_cursor ?? undefined;
      } while (cursor);
      const included = (message: (typeof messages)[number]) => open
        ? !message.resolved_at || (!!turnId && message.task_id === turnId)
        : !turnId || message.task_id === turnId;
      return messages.filter(included).flatMap(message => {
        const record = message.metadata.human_request;
        if (!record || typeof record !== "object") return [];
        const request = parseTaskHumanRequest({ ...record, id: message.id, taskId: message.task_id ?? "", sessionId,
          status: message.resolved_at ? "responded" : "pending", response: null, respondedBy: null,
          createdAt: message.created_at, respondedAt: message.resolved_at });
        return request ? [request] : [];
      });
    },
    enabled: !!wsId && !!sessionId,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────

export interface RespondHumanRequestInput {
  taskId: string;
  requestId: string;
  sessionId?: string;
  /** `{ option_id }` for permission requests, `{ answers }` for questions. */
  response: Record<string, unknown>;
}

export function useRespondHumanRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId, sessionId, response }: RespondHumanRequestInput) => {
      if (!sessionId) throw new Error("Decision conversation is missing");
      const text = typeof response.answers === "object" && response.answers
        ? Object.values(response.answers).map(String).join("; ") : String(response.option_id ?? "");
      return api.sendMessage(sessionId, { body_md: text, message_kind: "reply", reply_to_id: requestId, response });
    },
    onSettled: (_data, _error, { taskId }) => {
      // First-write-wins on the server; refetch settles both the winner and
      // any client that lost the race (409 → refetch shows who resolved it).
      void qc.invalidateQueries({ queryKey: chatKeys.humanRequests(taskId) });
    },
  });
}
