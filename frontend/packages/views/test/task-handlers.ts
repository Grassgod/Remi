import type { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";

// Exercise the real internal handler without adding it to core's public API or
// pulling core sources into the views package's rootDir during type checking.
const handlerPath = "../../core/realtime/sync/tasks.ts";
export const { createTaskHandlers } = await vi.importActual<{
  createTaskHandlers: (context: { qc: QueryClient }) => {
    handlers: { "task:message"?: (header: { task_id: string; degraded: boolean; seq_start: number; seq_end: number; issue_id?: string | null; chat_session_id?: string }) => void };
    dispose?: () => void;
  };
}>(handlerPath);
