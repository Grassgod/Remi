/**
 * Card action callback registry for handling interactive card events.
 *
 * Routes form submissions and button clicks back to pending Promises
 * (AskUserQuestion / ExitPlanMode).
 */

import { createLogger } from "./logger.js";

const log = createLogger("card-actions");

/** Pending action: resolve/reject callbacks keyed by action ID. */
interface PendingAction {
  resolve: (value: unknown) => void;
  reject: (reason: string) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  /** ChatId that owns this action — used for scoped rejection. */
  chatId?: string;
  /** Question metadata for AskUserQuestion form submissions. */
  questions?: Array<{ question: string; options: Array<{ label: string }> }>;
}

const pendingActions = new Map<string, PendingAction>();
let actionCounter = 0;

/** Timeout for user interaction (12 hours). */
const ACTION_TIMEOUT_MS = 12 * 60 * 60 * 1000;

function formAnswerText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formAnswerText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.content === "string") return obj.content;
    if (obj.text && typeof obj.text === "object") return formAnswerText((obj.text as Record<string, unknown>).content);
  }
  return String(value);
}

/**
 * Register a pending action that will be resolved when the user interacts with the card.
 * Returns a unique action ID to embed in card elements.
 */
export function registerPendingAction(
  resolve: (value: unknown) => void,
  reject: (reason: string) => void,
  questions?: Array<{ question: string; options: Array<{ label: string }> }>,
  chatId?: string,
): string {
  actionCounter = (actionCounter + 1) % 1_000_000;
  const suffix = `${actionCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const actionId = `a${Date.now().toString(36)}_${suffix}`;

  const timeoutTimer = setTimeout(() => {
    const action = pendingActions.get(actionId);
    if (action) {
      pendingActions.delete(actionId);
      action.reject("Timed out waiting for user response (12h)");
      log.warn(`Action ${actionId} timed out`);
    }
  }, ACTION_TIMEOUT_MS);

  pendingActions.set(actionId, { resolve, reject, timeoutTimer, chatId, questions });
  log.info(`Registered pending action: ${actionId} (chat=${chatId ?? "unknown"})`);
  return actionId;
}

/**
 * Resolve a pending action with the user's response.
 * Called from the card action callback handler.
 */
export function resolvePendingAction(actionId: string, value: unknown): boolean {
  const action = pendingActions.get(actionId);
  if (!action) {
    log.warn(`No pending action found for ${actionId}`);
    return false;
  }
  clearTimeout(action.timeoutTimer);
  pendingActions.delete(actionId);
  action.resolve(value);
  log.info(`Resolved action ${actionId}`);
  return true;
}

/** Reject one pending action by ID. */
export function rejectPendingAction(actionId: string, reason: string): boolean {
  const action = pendingActions.get(actionId);
  if (!action) {
    log.warn(`No pending action found for reject: ${actionId}`);
    return false;
  }
  clearTimeout(action.timeoutTimer);
  pendingActions.delete(actionId);
  action.reject(reason);
  log.info(`Rejected action ${actionId}: ${reason}`);
  return true;
}

/** Whether an action ID is still waiting for user input. */
export function hasPendingAction(actionId: string): boolean {
  return pendingActions.has(actionId);
}

/**
 * Process a card form submission event.
 * Extracts answers from form_value and resolves the pending action.
 */
export function handleFormSubmission(
  formName: string,
  formValue: Record<string, unknown>,
): boolean {
  // Try exact match first, then fallback to first pending action with questions
  let actionId = formName.startsWith("form_") ? formName.slice("form_".length) : formName;
  let action = pendingActions.get(actionId);
  if (!action) {
    // Check if it's a feedback form (actionId_feedback)
    if (formName.endsWith("_feedback")) {
      const baseActionId = formName.replace(/_feedback$/, "");
      const feedbackAction = pendingActions.get(baseActionId);
      if (feedbackAction) {
        const feedbackText = String(formValue.feedback_text ?? "");
        return resolvePendingAction(baseActionId, feedbackText || "User provided empty feedback");
      }
    }
    log.warn(`No pending action for form: ${formName}`);
    return false;
  }

  // Parse form values into answers dict using stored question metadata
  const questions = action.questions;
  if (questions) {
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const customKey = `q${i}_custom`;
      const selectKey = `q${i}`;
      const customValue = formAnswerText(formValue[customKey]).trim();
      const selected = formValue[selectKey];
      log.info(`form q${i}: select=${JSON.stringify(selected)} custom="${customValue}" type=${typeof selected}`);

      if (customValue) {
        // Custom input overrides checker selection
        answers[questions[i].question] = customValue;
      } else {
        // Use checker selection (may be array for multi-select or string)
        answers[questions[i].question] = formAnswerText(selected);
      }
    }
    log.info(`form answers: ${JSON.stringify(answers)}`);
    return resolvePendingAction(actionId, answers);
  }

  // Generic form: resolve with raw form values
  return resolvePendingAction(actionId, formValue);
}

/**
 * Process a button click event (for plan review or AskUserQuestion).
 */
export function handleButtonClick(valueJson: string): boolean {
  try {
    const value = JSON.parse(valueJson) as Record<string, string>;

    // AskUserQuestion button: { _action_id, q, opt, label }
    if (value._action_id) {
      const action = pendingActions.get(value._action_id);
      if (!action) {
        log.warn(`No pending action for button: ${value._action_id}`);
        return false;
      }
      const questions = action.questions;
      if (questions) {
        const qIdx = parseInt(value.q ?? "0", 10);
        const question = questions[qIdx]?.question ?? `q_${qIdx}`;
        const answers: Record<string, string> = { [question]: value.label };
        return resolvePendingAction(value._action_id, answers);
      }
      return resolvePendingAction(value._action_id, value.label);
    }

    // Generic ACP permission option button.
    if (value._permission_action_id && value.decision) {
      return resolvePendingAction(value._permission_action_id, { decision: value.decision });
    }

    // Plan review button: { action, decision }
    if (value.action && value.decision) {
      return resolvePendingAction(value.action, value.decision);
    }

    // Mission approve/reject button: { _action_type, missionId }
    if (value._action_type?.startsWith("mission_")) {
      // Handled externally by mission module — emit event via callback
      if (_missionActionHandler) {
        _missionActionHandler(value._action_type, value.missionId);
        return true;
      }
      log.warn(`Mission action received but no handler registered: ${value._action_type}`);
      return false;
    }

    return false;
  } catch {
    log.warn(`Failed to parse button value: ${valueJson}`);
    return false;
  }
}

/**
 * Reject pending actions for a specific chatId only.
 * Used when a new message arrives — only cancels actions for that chat, not others.
 */
export function rejectPendingActionsForChat(chatId: string, reason: string): number {
  let count = 0;
  for (const [actionId, action] of pendingActions) {
    if (action.chatId === chatId) {
      clearTimeout(action.timeoutTimer);
      action.reject(reason);
      pendingActions.delete(actionId);
      count++;
    }
  }
  if (count > 0) {
    log.info(`Rejected ${count} pending action(s) for chat ${chatId}: ${reason}`);
  }
  return count;
}

/**
 * Reject ALL pending actions (AskUserQuestion / ExitPlanMode).
 * Used when /esc is sent globally.
 * This unblocks the provider's `await promise`, which in turn releases the lane lock.
 */
export function rejectAllPendingActions(reason: string): number {
  let count = 0;
  for (const [actionId, action] of pendingActions) {
    clearTimeout(action.timeoutTimer);
    action.reject(reason);
    count++;
  }
  pendingActions.clear();
  if (count > 0) {
    log.info(`Rejected ${count} pending action(s): ${reason}`);
  }
  return count;
}

/** Get count of pending actions (for diagnostics). */
export function getPendingActionCount(): number {
  return pendingActions.size;
}

// ── Mission action handler ──

type MissionActionHandler = (actionType: string, missionId: string) => void;
let _missionActionHandler: MissionActionHandler | null = null;

/** Register a handler for mission approve/reject card button clicks. */
export function registerMissionActionHandler(handler: MissionActionHandler): void {
  _missionActionHandler = handler;
}
