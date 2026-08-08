"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useCurrentWorkspace, useWorkspacePaths } from "@multiremi/core/paths";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { agentListOptions, memberListOptions, squadMemberStatusOptions, workspaceKeys } from "@multiremi/core/workspace/queries";
import { CreateAgentDialog } from "../../agents/components/create-agent-dialog";
import { useNavigation } from "../../navigation";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { PageHeader } from "../../layout/page-header";
import { Trash2 } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multiremi/ui/components/ui/alert-dialog";
import { toast } from "sonner";
import type { Squad, SquadMember, SquadMemberStatus, Agent, CreateAgentRequest } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { SquadHeaderAvatar } from "./squad-header-avatar";
import { SquadDetailInspector } from "./squad-detail-inspector";
import { SquadOverviewPane } from "./squad-overview-pane";
import { AddMemberDialog } from "./add-member-dialog";



export function SquadDetailPage() {
  const { t } = useT("squads");
  const workspace = useCurrentWorkspace();
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname, push } = useNavigation();
  const queryClient = useQueryClient();
  const squadId = pathname.split("/").pop() ?? "";

  const { data: squad, refetch: refetchSquad } = useQuery<Squad>({
    queryKey: [...workspaceKeys.squads(wsId), squadId],
    queryFn: () => api.getSquad(squadId),
    enabled: !!workspace?.id && !!squadId,
  });

  const { data: members = [], refetch: refetchMembers } = useQuery<SquadMember[]>({
    queryKey: [...workspaceKeys.squads(wsId), squadId, "members"],
    queryFn: () => api.listSquadMembers(squadId),
    enabled: !!workspace?.id && !!squadId,
  });

  // Per-squad working/idle/offline + active-issue snapshot. WS task / agent /
  // daemon events invalidate this via use-realtime-sync; the staleTime is a
  // tab-focus safety net. Indexed by member_id so SquadMembersTab can look up
  // its row in O(1).
  const { data: memberStatusResp } = useQuery({
    ...squadMemberStatusOptions(wsId, squadId),
    enabled: !!workspace?.id && !!squadId,
  });
  const memberStatusById = useMemo(() => {
    const map = new Map<string, SquadMemberStatus>();
    for (const s of memberStatusResp?.members ?? []) map.set(s.member_id, s);
    return map;
  }, [memberStatusResp]);

  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: wsMembers = [] } = useQuery(memberListOptions(wsId));

  // Runtimes are only fetched when the Create Agent dialog might open;
  // gating on isWorkspaceAdmin below means non-admins never trigger the
  // request. The runtime list mirrors the agents page so the picker
  // (and the "only my runtimes" filter) behaves identically here.
  const currentUser = useAuthStore((s) => s.user);
  const myRole = useMemo(() => {
    if (!currentUser) return null;
    return wsMembers.find((m) => m.user_id === currentUser.id)?.role ?? null;
  }, [wsMembers, currentUser]);
  const isWorkspaceAdmin = myRole === "owner" || myRole === "admin";

  const [showAddMember, setShowAddMember] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const updateSquadMut = useMutation({
    mutationFn: (data: { name?: string; description?: string; instructions?: string; avatar_url?: string; leader_id?: string }) => api.updateSquad(squadId, data),
    onSuccess: () => {
      refetchSquad();
      refetchMembers();
      queryClient.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) });
    },
  });

  const addMemberMut = useMutation({
    mutationFn: (input: { type: "agent" | "member"; id: string; role?: string }) =>
      api.addSquadMember(squadId, {
        member_type: input.type,
        member_id: input.id,
        role: input.role?.trim() || undefined,
      }),
    onSuccess: () => { refetchMembers(); toast.success("Member added"); },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : "Failed to add member"),
  });

  const removeMemberMut = useMutation({
    mutationFn: (m: SquadMember) => api.removeSquadMember(squadId, { member_type: m.member_type, member_id: m.member_id }),
    onSuccess: () => { refetchMembers(); toast.success("Member removed"); },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : "Failed to remove member"),
  });

  const updateRoleMut = useMutation({
    mutationFn: (input: { member: SquadMember; role: string }) =>
      api.updateSquadMemberRole(squadId, {
        member_type: input.member.member_type,
        member_id: input.member.member_id,
        role: input.role,
      }),
    onSuccess: () => { refetchMembers(); toast.success("Role updated"); },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : "Failed to update role"),
  });

  const setLeaderMut = useMutation({
    mutationFn: (agentId: string) => api.updateSquad(squadId, { leader_id: agentId }),
    onSuccess: () => {
      refetchSquad();
      refetchMembers();
      queryClient.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) });
      toast.success("Leader updated");
    },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : "Failed to update leader"),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.deleteSquad(squadId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) }); push(p.squads()); toast.success("Squad archived"); },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : "Failed to archive squad"),
  });

  // CreateAgentDialog's onCreate contract: hit POST /api/agents and
  // return the created agent so the dialog can run its skill follow-up.
  // We deliberately do NOT navigate to the agent detail page (that's
  // the agents-page behaviour) — the user clicked Create Agent from
  // inside this squad, so the dialog will stay open just long enough
  // to also call addSquadMember (handled by the dialog when squadId
  // is set), then close the user back to Members where they can
  // verify the new agent appeared. Cache-update keeps the agents list
  // fresh for any pickers that read from it.
  const handleCreateAgent = async (data: CreateAgentRequest): Promise<Agent> => {
    const agent = await api.createAgent(data);
    queryClient.setQueryData<Agent[]>(workspaceKeys.agents(wsId), (current = []) => {
      const exists = current.some((a) => a.id === agent.id);
      return exists ? current.map((a) => (a.id === agent.id ? agent : a)) : [...current, agent];
    });
    queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
    return agent;
  };

  const getEntityName = (type: string, id: string) => {
    if (type === "agent") return agents.find((a: Agent) => a.id === id)?.name ?? id.slice(0, 8);
    return wsMembers.find((m) => m.user_id === id)?.name ?? id.slice(0, 8);
  };

  if (!squad) {
    return <SquadDetailSkeleton />;
  }

  const availableAgents = agents.filter((a: Agent) => !a.archived_at && !members.some((m) => m.member_type === "agent" && m.member_id === a.id));
  const availableMembers = wsMembers.filter((m) => !members.some((sm) => sm.member_type === "member" && sm.member_id === m.user_id));
  const isLeader = (m: SquadMember) => m.member_type === "agent" && squad.leader_id === m.member_id;
  const isArchived = (m: SquadMember) =>
    m.member_type === "agent" && !!agents.find((a: Agent) => a.id === m.member_id)?.archived_at;

  const initials = squad.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <BreadcrumbHeader
        segments={[{ href: p.squads(), label: t(($) => $.page.title) }]}
        leaf={
          <>
            <SquadHeaderAvatar squad={squad} initials={initials} />
            <h1 className="truncate text-sm font-medium text-foreground">{squad.name}</h1>
          </>
        }
        actions={
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmArchive(true)}>
            <Trash2 className="size-3.5 mr-1" />
            {t(($) => $.inspector.archive_button)}
          </Button>
        }
      />

      {/* Two-column grid mirrors agent-detail-page: left inspector (identity +
          properties + leader), right pane with tabs (Members | Instructions).
          Mobile collapses to stacked single column. */}
      <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto p-3 md:grid md:grid-cols-[280px_minmax(0,1fr)] md:gap-4 md:overflow-hidden md:p-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <SquadDetailInspector
          squad={squad}
          memberCount={members.length}
          leaderName={getEntityName("agent", squad.leader_id)}
          creatorName={getEntityName("member", squad.creator_id)}
          uploadingAvatar={updateSquadMut.isPending}
          onUploadAvatar={(url) => updateSquadMut.mutateAsync({ avatar_url: url })}
          onRename={async (next) => { await updateSquadMut.mutateAsync({ name: next.trim() }); }}
          onUpdateDescription={async (next) => { await updateSquadMut.mutateAsync({ description: next }); }}
        />

        <SquadOverviewPane
          squad={squad}
          members={members}
          memberStatusById={memberStatusById}
          isLeader={isLeader}
          isArchived={isArchived}
          getEntityName={getEntityName}
          onAddMemberClick={() => setShowAddMember(true)}
          onCreateAgentClick={isWorkspaceAdmin ? () => setShowCreateAgent(true) : undefined}
          onSetLeader={(id) => setLeaderMut.mutate(id)}
          onRemoveMember={(m) => removeMemberMut.mutate(m)}
          onUpdateRole={async (m, role) => { await updateRoleMut.mutateAsync({ member: m, role }); }}
          onSaveInstructions={async (next) => { await updateSquadMut.mutateAsync({ instructions: next }); toast.success("Instructions saved"); }}
          setLeaderPending={setLeaderMut.isPending}
        />
      </div>

      {showAddMember && (
        <AddMemberDialog
          availableMembers={availableMembers}
          availableAgents={availableAgents}
          onClose={() => setShowAddMember(false)}
          onSubmit={async (input) => { await addMemberMut.mutateAsync(input); }}
        />
      )}

      {/* Squad-scoped create flow: same dialog as the Agents page but
          with squadId set, so the dialog runs api.addSquadMember after
          api.createAgent and skips the agent-detail navigation. Only
          mounted for workspace owner/admin since AddSquadMember is
          owner/admin-gated server-side; for everyone else the trigger
          never renders. */}
      {showCreateAgent && isWorkspaceAdmin && (
        <CreateAgentDialog
          squadId={squadId}
          onClose={() => setShowCreateAgent(false)}
          onCreate={handleCreateAgent}
        />
      )}

      {confirmArchive && (
        <AlertDialog
          open
          onOpenChange={(v) => { if (!v && !deleteMut.isPending) setConfirmArchive(false); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(($) => $.archive_dialog.title)}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(($) => $.archive_dialog.description, { name: squad.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMut.isPending}>
                {t(($) => $.archive_dialog.cancel)}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                {deleteMut.isPending
                  ? t(($) => $.archive_dialog.archiving)
                  : t(($) => $.archive_dialog.confirm)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

// Initial-load skeleton — mirrors the two-column layout of the loaded page
// (left inspector + right tabs panel) so the swap to real content doesn't
// shift layout. Column widths match the md:/lg: breakpoints used below.
function SquadDetailSkeleton() {
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader className="px-5">
        <Skeleton className="h-5 w-48" />
      </PageHeader>
      <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto p-3 md:grid md:grid-cols-[280px_minmax(0,1fr)] md:gap-4 md:overflow-hidden md:p-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4 rounded-lg border p-5">
          <Skeleton className="h-16 w-16 rounded-lg" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-full" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
        <div className="flex flex-col gap-4 rounded-lg border p-6">
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      </div>
    </div>
  );
}
