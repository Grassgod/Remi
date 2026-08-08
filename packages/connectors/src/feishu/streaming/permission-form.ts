// Permission-form lifecycle for the Feishu streaming session (audit S17 split).
//
// A streaming card carries at most one live permission form (tool approval,
// AskUserQuestion, ExitPlanMode). PermissionFormStore owns that pending form
// plus the panels retained after a form is submitted — the panel stays visible
// so the answered question is still readable, while the buttons go away.
//
// The HTTP calls stay on the session; this module owns the bookkeeping, the
// element-id contract and the insert ordering.
import type { PermissionFormElements } from "../permission-ui.js";
import type { RetainedPermissionPanel } from "./card-elements.js";

export class PermissionFormStore {
  /** Active permission form (rendered inline on degraded-mode card rebuilds). */
  pending: PermissionFormElements | null = null;

  private readonly retainedPanels = new Map<string, RetainedPermissionPanel>();

  /** Panels kept after their interactive form was submitted. */
  retained(): RetainedPermissionPanel[] {
    return [...this.retainedPanels.values()];
  }

  /**
   * Clear the pending form once its action resolved, optionally keeping its
   * panel so the submitted content survives into later card rebuilds.
   */
  settle(actionId: string, preservePanel: boolean): void {
    if (preservePanel && this.pending?.panel) {
      this.retainedPanels.set(actionId, {
        hr: this.pending.hr,
        panel: this.pending.panel,
      });
    }
    this.pending = null;
  }
}

/** Card element ids to delete when a permission form is removed. */
export function permissionElementIds(actionId: string, preservePanel: boolean): string[] {
  return preservePanel
    ? [`perm_${actionId}`]
    : [`perm_hr_${actionId}`, `perm_plan_${actionId}`, `perm_${actionId}`];
}

/**
 * Insert a permission form's elements in render order, each one anchored after
 * the previous. `insertAfter` must throw on failure so the caller can fall back
 * to a degraded full-card rebuild.
 */
export async function insertPermissionFormElements(
  form: PermissionFormElements,
  insertAfter: (afterElementId: string, element: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const hrId = (form.hr as Record<string, unknown>).element_id as string;
  await insertAfter("content", form.hr);
  if (form.panel) {
    const panelId = (form.panel as Record<string, unknown>).element_id as string;
    await insertAfter(hrId, form.panel);
    await insertAfter(panelId, form.form);
  } else {
    await insertAfter(hrId, form.form);
  }
}
