import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../api";
import { parseWithFallback } from "../api/schema";
import { chatKeys } from "./queries";

// ─── Types ───────────────────────────────────────────────────────────────
//
// A human request is an agent-side pause routed through the server: either a
// tool-permission prompt ("permission") or an AskUserQuestion form
// ("question"). The worker holds the ACP promise open until someone responds
// here (or the request times out), so responding resumes the task.

export type TaskHumanRequestKind = "permission" | "question";
export type TaskHumanRequestStatus = "pending" | "responded" | "timeout" | "cancelled";

export interface HumanRequestPermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

export interface HumanRequestQuestion {
  fieldKey: string;
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
  kind: TaskHumanRequestKind;
  payload: {
    tool_call?: { title?: string } | null;
    options?: HumanRequestPermissionOption[];
    message?: string;
    questions?: HumanRequestQuestion[];
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

const questionSchema = z.object({
  fieldKey: z.string(),
  question: z.object({
    question: z.string(),
    header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).default([]),
    multiSelect: z.boolean().optional(),
  }),
});

const humanRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["permission", "question"]),
  payload: z
    .object({
      tool_call: z.object({ title: z.string().optional() }).nullish(),
      options: z.array(permissionOptionSchema).optional(),
      message: z.string().optional(),
      questions: z.array(questionSchema).optional(),
    })
    .loose(),
  status: z.enum(["pending", "responded", "timeout", "cancelled"]),
  response: z.record(z.string(), z.unknown()).nullable(),
  respondedBy: z.string().nullable(),
  createdAt: z.string(),
  respondedAt: z.string().nullable(),
});

const humanRequestListSchema = z.object({ requests: z.array(humanRequestSchema) });

// ─── Queries ─────────────────────────────────────────────────────────────

export function humanRequestsOptions(taskId: string) {
  return queryOptions({
    queryKey: chatKeys.humanRequests(taskId),
    queryFn: async (): Promise<TaskHumanRequest[]> => {
      const raw = await api.listTaskHumanRequests(taskId);
      const parsed = parseWithFallback(raw, humanRequestListSchema, { requests: [] as TaskHumanRequest[] }, {
        endpoint: `/api/tasks/${taskId}/human-requests`,
      });
      return parsed.requests as TaskHumanRequest[];
    },
    enabled: taskId.length > 0,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────

export interface RespondHumanRequestInput {
  taskId: string;
  requestId: string;
  /** `{ option_id }` for permission requests, `{ answers }` for questions. */
  response: Record<string, unknown>;
}

export function useRespondHumanRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, requestId, response }: RespondHumanRequestInput) =>
      api.respondTaskHumanRequest(taskId, requestId, response),
    onSettled: (_data, _error, { taskId }) => {
      // First-write-wins on the server; refetch settles both the winner and
      // any client that lost the race (409 → refetch shows who resolved it).
      void qc.invalidateQueries({ queryKey: chatKeys.humanRequests(taskId) });
    },
  });
}
