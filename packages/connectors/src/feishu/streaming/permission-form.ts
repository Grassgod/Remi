// Permission-form lifecycle for the Feishu streaming session (audit S17 split).
//
// A streaming card carries at most one live permission form (tool approval,
// AskUserQuestion, ExitPlanMode). PermissionFormStore owns that pending form
// plus the panels retained after a form is submitted — the panel stays visible
// so the answered question is still readable, while the buttons go away.
//
// HTTP calls stay on the session; this module owns form bookkeeping only.
import type { PermissionFormElements } from "../permission-ui.js";
import type { RetainedPermissionPanel } from "./card-elements.js";

export class PermissionFormStore {
  /** Active permission form rendered in full-card patches. */
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
