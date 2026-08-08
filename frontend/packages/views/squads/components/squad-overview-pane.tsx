"use client";

import { useState } from "react";
import { Users, FileText } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multiremi/ui/components/ui/alert-dialog";
import type { Squad, SquadMember, SquadMemberStatus } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { SquadMembersTab } from "./tabs/members-tab";
import { SquadInstructionsTab } from "./tabs/instructions-tab";

// ---------------------------------------------------------------------------
// SquadOverviewPane — right column with two tabs (Members | Instructions).
// Mirrors AgentOverviewPane: dirty-guard via AlertDialog when switching tabs
// with unsaved Instructions.
// ---------------------------------------------------------------------------
type SquadDetailTab = "members" | "instructions";

const squadDetailTabs: { id: SquadDetailTab; label: string; icon: typeof FileText }[] = [
  { id: "members", label: "Members", icon: Users },
  { id: "instructions", label: "Instructions", icon: FileText },
];

export function SquadOverviewPane({
  squad,
  members,
  memberStatusById,
  isLeader,
  isArchived,
  getEntityName,
  onAddMemberClick,
  onCreateAgentClick,
  onSetLeader,
  onRemoveMember,
  onUpdateRole,
  onSaveInstructions,
  setLeaderPending,
}: {
  squad: Squad;
  members: SquadMember[];
  memberStatusById: Map<string, SquadMemberStatus>;
  isLeader: (m: SquadMember) => boolean;
  isArchived: (m: SquadMember) => boolean;
  getEntityName: (type: string, id: string) => string;
  onAddMemberClick: () => void;
  // Optional — only passed when the current user can manage the squad
  // (workspace owner/admin). Hidden otherwise so plain members don't
  // see a button they can't action.
  onCreateAgentClick?: () => void;
  onSetLeader: (agentId: string) => void;
  onRemoveMember: (m: SquadMember) => void;
  onUpdateRole: (m: SquadMember, role: string) => Promise<void>;
  onSaveInstructions: (next: string) => Promise<void>;
  setLeaderPending: boolean;
}) {
  const { t } = useT("squads");
  const [activeTab, setActiveTab] = useState<SquadDetailTab>("members");
  const [activeDirty, setActiveDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<SquadDetailTab | null>(null);

  const requestTabChange = (next: SquadDetailTab) => {
    if (next === activeTab) return;
    if (activeDirty) { setPendingTab(next); return; }
    setActiveTab(next);
  };

  const commitTabChange = () => {
    if (pendingTab) {
      setActiveTab(pendingTab);
      setActiveDirty(false);
      setPendingTab(null);
    }
  };

  return (
    <div className="flex min-h-[60vh] flex-col overflow-hidden rounded-lg border bg-background md:h-full md:min-h-0">
      <div className="flex shrink-0 items-center gap-0 overflow-x-auto border-b px-2 md:px-4">
        {squadDetailTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => requestTabChange(tab.id)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === "members" && (
          <div className="flex h-full flex-col p-4 md:p-6">
            <SquadMembersTab
              members={members}
              memberStatusById={memberStatusById}
              isLeader={isLeader}
              isArchived={isArchived}
              getEntityName={getEntityName}
              onAddMemberClick={onAddMemberClick}
              onCreateAgentClick={onCreateAgentClick}
              onSetLeader={onSetLeader}
              onRemoveMember={onRemoveMember}
              onUpdateRole={onUpdateRole}
              setLeaderPending={setLeaderPending}
            />
          </div>
        )}
        {activeTab === "instructions" && (
          <div className="flex h-full flex-col p-4 md:p-6">
            <SquadInstructionsTab
              squad={squad}
              onSave={onSaveInstructions}
              onDirtyChange={setActiveDirty}
            />
          </div>
        )}
      </div>

      {pendingTab !== null && (
        <AlertDialog open onOpenChange={(v) => { if (!v) setPendingTab(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(($) => $.discard_changes_dialog.title)}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(($) => $.discard_changes_dialog.description)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t(($) => $.discard_changes_dialog.keep_editing)}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={commitTabChange}>
                {t(($) => $.discard_changes_dialog.discard_button)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
