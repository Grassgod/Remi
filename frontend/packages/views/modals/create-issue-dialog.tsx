"use client";

import { useState } from "react";
import { Dialog, DialogContent } from "@multiremi/ui/components/ui/dialog";
import {
  useCreateModeStore,
  type CreateMode,
} from "@multiremi/core/issues/stores/create-mode-store";
import { AgentCreatePanel } from "./quick-create-issue";
import { ManualCreatePanel, manualDialogContentClass } from "./create-issue";

export function createIssueDialogContentClass(
  mode: CreateMode,
  isExpanded: boolean,
  backlogHintIssueId: string | null,
) {
  return manualDialogContentClass(
    isExpanded,
    mode === "manual" ? backlogHintIssueId : null,
  );
}

/**
 * Shell that owns the single `<Dialog>` AND `<DialogContent>` for the
 * create-issue flow. Mode switching unmounts/mounts only the inner panel
 * body — the Portal, Backdrop, and Popup all stay in the DOM, so Base UI
 * never replays the open animation. That's what makes the switch feel
 * instant; an earlier version put `<DialogContent>` inside each panel and
 * the close→open animation cycle still fired on every toggle.
 *
 * `initialMode` comes from the modal registry (`quick-create-issue` →
 * agent, `create-issue` → manual). Subsequent switches are local state
 * only and never round-trip through the modal store.
 *
 * Carry payload: when a panel switches mode it can hand a payload up via
 * `onSwitchMode`; the shell stores it as the next panel's `data` so seeding
 * works exactly like a fresh open.
 *
 * Manual-mode `isExpanded` / `backlogHintIssueId` are lifted up because they
 * drive `DialogContent`'s className — the className lives here in the shell
 * since the Popup is here, but the toggles for those states live in the
 * manual panel body.
 */
export function CreateIssueDialog({
  onClose,
  initialMode,
  data,
}: {
  onClose: () => void;
  initialMode: CreateMode;
  data?: Record<string, unknown> | null;
}) {
  const setLastMode = useCreateModeStore((s) => s.setLastMode);
  const [mode, setMode] = useState<CreateMode>(initialMode);
  const [panelData, setPanelData] = useState(data ?? null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [backlogHintIssueId, setBacklogHintIssueId] = useState<string | null>(null);

  const switchTo = (next: CreateMode) => (carry?: Record<string, unknown> | null) => {
    setLastMode(next);
    setPanelData(carry ?? null);
    setMode(next);
  };

  // Both creation modes share one footprint so switching only changes the
  // form content, not the surrounding dialog. The backlog hint remains a
  // manual-only compact state.
  const className = createIssueDialogContentClass(
    mode,
    isExpanded,
    backlogHintIssueId,
  );

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        finalFocus={false}
        showCloseButton={false}
        className={className}
      >
        {mode === "agent" ? (
          <AgentCreatePanel
            onClose={onClose}
            onSwitchMode={switchTo("manual")}
            data={panelData}
            isExpanded={isExpanded}
            setIsExpanded={setIsExpanded}
          />
        ) : (
          <ManualCreatePanel
            onClose={onClose}
            onSwitchMode={switchTo("agent")}
            data={panelData}
            isExpanded={isExpanded}
            setIsExpanded={setIsExpanded}
            backlogHintIssueId={backlogHintIssueId}
            setBacklogHintIssueId={setBacklogHintIssueId}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
