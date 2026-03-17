/**
 * Card action callback registry for handling interactive card events.
 *
 * Routes form submissions and button clicks back to pending Promises
 * (AskUserQuestion / ExitPlanMode).
 */

import { createLogger } from "../../logger.js";

const log = createLogger("card-actions");

/** Pending action: resolve/reject callbacks keyed by action ID. */
interface PendingAction {
  resolve: (value: unknown) => void;
  reject: (reason: string) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  /** Question metadata for AskUserQuestion form submissions. */
  questions?: Array<{ question: string; options: Array<{ label: string }> }>;
}

const pendingActions = new Map<string, PendingAction>();

/** Timeout for user interaction (30 minutes). */
const ACTION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Register a pending action that will be resolved when the user interacts with the card.
 * Returns a unique action ID to embed in card elements.
 */
export function registerPendingAction(
  resolve: (value: unknown) => void,
  reject: (reason: string) => void,
  questions?: Array<{ question: string; options: Array<{ label: string }> }>,
): string {
  const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const timeoutTimer = setTimeout(() => {
    const action = pendingActions.get(actionId);
    if (action) {
      pendingActions.delete(actionId);
      action.reject("Timed out waiting for user response (30 min)");
      log.warn(`Action ${actionId} timed out`);
    }
  }, ACTION_TIMEOUT_MS);

  pendingActions.set(actionId, { resolve, reject, timeoutTimer, questions });
  log.info(`Registered pending action: ${actionId}`);
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

/**
 * Process a card form submission event.
 * Extracts answers from form_value and resolves the pending action.
 */
export function handleFormSubmission(
  formName: string,
  formValue: Record<string, unknown>,
): boolean {
  // Try exact match first, then fallback to first pending action with questions
  let actionId = formName;
  let action = pendingActions.get(formName);
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
    // Fallback: find first pending action with questions (AskUserQuestion)
    for (const [id, a] of pendingActions) {
      if (a.questions) {
        actionId = id;
        action = a;
        log.info(`Form fallback: matched pending action ${id} for form "${formName}"`);
        break;
      }
    }
    if (!action) {
      log.warn(`No pending action for form: ${formName}`);
      return false;
    }
  }

  // Parse form values into answers dict using stored question metadata
  const questions = action.questions;
  if (questions) {
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const customKey = `q_${i}_custom`;
      const selectKey = `q_${i}`;
      const customValue = String(formValue[customKey] ?? "").trim();

      if (customValue) {
        // Custom input overrides selection
        answers[questions[i].question] = customValue;
      } else {
        // Use selected option
        const selectedValue = formValue[selectKey];
        if (typeof selectedValue === "string" && selectedValue.startsWith("opt_")) {
          const optIdx = parseInt(selectedValue.replace("opt_", ""), 10);
          const option = questions[i].options[optIdx];
          answers[questions[i].question] = option?.label ?? selectedValue;
        } else if (Array.isArray(selectedValue)) {
          // Multi-select: array of values
          const labels = selectedValue
            .map((v) => {
              if (typeof v === "string" && v.startsWith("opt_")) {
                const idx = parseInt(v.replace("opt_", ""), 10);
                return questions[i].options[idx]?.label ?? v;
              }
              return String(v);
            })
            .join(", ");
          answers[questions[i].question] = labels;
        } else {
          answers[questions[i].question] = String(selectedValue ?? "");
        }
      }
    }
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

    // Plan review button: { action, decision }
    if (value.action && value.decision) {
      return resolvePendingAction(value.action, value.decision);
    }

    return false;
  } catch {
    log.warn(`Failed to parse button value: ${valueJson}`);
    return false;
  }
}

/**
 * Reject ALL pending actions (AskUserQuestion / ExitPlanMode).
 * Used when /esc is sent or a new message arrives while an interactive prompt is pending.
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
