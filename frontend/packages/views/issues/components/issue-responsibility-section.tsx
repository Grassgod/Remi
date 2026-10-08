"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import type { IssueDeliveryView } from "@multiremi/core/api/schemas";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { issueResponsibilityOptions, issueDeliveriesOptions, issueKeys } from "@multiremi/core/issues/queries";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import type { Issue } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { Markdown } from "../../common/markdown";
import { useT } from "../../i18n";
import { IssueDecisionPanel } from "./issue-decision-panel";
import { AppLink } from "../../navigation";

export function RootHumanPicker({ value, onChange, disabled = false, defaultSelf = false }: { value: string | null; onChange: (id: string) => void; disabled?: boolean; defaultSelf?: boolean }) {
  const wsId = useWorkspaceId();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const userId = useAuthStore(s => s.user?.id);
  const ownMemberId = members.find(member => member.user_id === userId)?.id;
  useEffect(() => { if (defaultSelf && !value && ownMemberId) onChange(ownMemberId); }, [defaultSelf, value, ownMemberId, onChange]);
  const { t } = useT("issues");
  return <label className="flex min-w-0 flex-col gap-1 text-xs"><span>{t($ => $.responsibility.human)}</span>
    <select className="h-8 min-w-0 rounded border bg-background px-2" aria-label={t($ => $.responsibility.human)} value={value ?? ""} disabled={disabled} onChange={e => e.target.value && onChange(e.target.value)}>
      <option value="">{t($ => $.responsibility.select)}</option>
      {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
    </select>
  </label>;
}

export function IssueResponsibilitySection({ issue, enabled = true, getActorName }: { issue: Issue; enabled?: boolean; getActorName: (type: string, id: string) => string }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const paths = useWorkspacePaths();
  const userId = useAuthStore(s => s.user?.id);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const memberId = members.find(member => member.user_id === userId)?.id;
  const responsibility = useQuery({ ...issueResponsibilityOptions(wsId, issue.id), enabled });
  const deliveries = useQuery({ ...issueDeliveriesOptions(wsId, issue.id), enabled });
  const [nextHuman, setNextHuman] = useState<string | null>(null);
  const transfer = useMutation({ mutationFn: (id: string) => api.updateIssue(issue.id, { responsible_member_id: id }), onSuccess: () => { setNextHuman(null); void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) }); } });
  const result = responsibility.data;
  return <section className="space-y-3 border-t pt-3" data-issue-responsibility>
    <h3 className="text-xs font-medium">{t($ => $.responsibility.title)}</h3>
    {responsibility.isError ? <Button variant="ghost" size="sm" onClick={() => void responsibility.refetch()}>{t($ => $.responsibility.load_failed)}</Button> : result && <dl className="grid grid-cols-[auto_1fr] gap-2 text-xs">
      <dt>{t($ => $.responsibility.execution)}</dt><dd className="break-words">{result.executionOwner?.name ?? t($ => $.responsibility.unavailable)}</dd>
      <dt>{t($ => $.responsibility.review)}</dt><dd className="break-words">{result.reviewOwner?.name ?? t($ => $.responsibility.unavailable)}</dd>
      <dt>{t($ => $.responsibility.human)}</dt><dd className="break-words">{result.rootHuman?.name ?? t($ => $.responsibility.unavailable)}</dd>
    </dl>}
    {result?.unresolved.map(failure => <div key={`${failure.issueId}:${failure.reason}`} className="space-y-1 text-xs">
      <p className="break-words text-amber-700">{t($ => $.responsibility.unavailable)} · {failure.issueId} · {failure.reason}</p>
      <AppLink className="block text-primary" href={failure.issueId === issue.id && issue.assignee_type === "squad" && issue.assignee_id && ["team_unavailable", "leader_missing"].includes(failure.reason) ? paths.squadDetail(issue.assignee_id) : paths.issueDetail(failure.issueId)}>{t($ => $.responsibility.configure)}</AppLink>
    </div>)}
    {issue.parent_issue_id && result?.rootIssueId && <AppLink className="block text-xs text-primary" href={paths.issueDetail(result.rootIssueId)}>{t($ => $.responsibility.human)} · {result.rootHuman?.name ?? t($ => $.responsibility.unavailable)}</AppLink>}
    {!issue.parent_issue_id && memberId && <div className="space-y-2">
      <RootHumanPicker value={nextHuman ?? issue.responsible_member_id ?? null} onChange={setNextHuman} disabled={transfer.isPending} />
      {nextHuman && nextHuman !== issue.responsible_member_id && <Button size="sm" variant="outline" disabled={transfer.isPending} onClick={() => transfer.mutate(nextHuman)}>{t($ => $.responsibility.transfer)}</Button>}
      {transfer.error && <p role="alert" className="text-xs text-destructive">{transfer.error.message}</p>}
    </div>}
    <IssueDecisionPanel issueId={issue.id} pendingCount={0} showOwnerOnly canAnswer={false} getActorName={getActorName} />
    {deliveries.isError && <Button size="sm" variant="ghost" onClick={() => void deliveries.refetch()}>{t($ => $.responsibility.load_failed)}</Button>}
    {deliveries.data?.map(delivery => <DeliveryCard key={delivery.id} delivery={delivery} canReview={delivery.reviewOwner.type === "member" && delivery.reviewOwner.id === memberId}
      authorizeAgentId={!issue.parent_issue_id && result?.rootHuman?.id === memberId ? result?.executionOwner?.id : undefined} />)}
  </section>;
}

function DeliveryCard({ delivery, canReview, authorizeAgentId }: { delivery: IssueDeliveryView; canReview: boolean; authorizeAgentId?: string }) {
  const { t } = useT("issues");
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [body, setBody] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) }); };
  const response = useMutation({ mutationFn: (action: "accept" | "return") => api.respondIssueDelivery(delivery.issueId, delivery.id, { action, body: body.trim(), revision: delivery.responsibilityRevision }), onSettled: refresh });
  const authorization = useMutation({ mutationFn: (agentId: string | null) => api.authorizeIssueDelivery(delivery.issueId, delivery.id, { agentId, revision: delivery.responsibilityRevision }), onSettled: refresh });
  return <article className="space-y-2 rounded border p-2 text-xs" data-issue-delivery={delivery.id}>
    <p>{delivery.submittedBy.name} → {delivery.reviewOwner.name} · {delivery.status}</p><Markdown mode="minimal">{delivery.summary}</Markdown>
    {delivery.responseBody && <Markdown mode="minimal">{delivery.responseBody}</Markdown>}
    {delivery.responseMessageId && <AppLink href={`${paths.issueDetail(delivery.issueId)}?comment=${encodeURIComponent(delivery.responseMessageId)}`}>{t($ => $.responsibility.source)}</AppLink>}
    {delivery.authorization && <p>{t($ => $.responsibility.authorized)} · {delivery.authorization.agentId} · {delivery.authorization.grantedAt}</p>}
    {canReview && delivery.status === "pending" && !response.isSuccess && <>
      <Textarea aria-label={t($ => $.responsibility.reason)} placeholder={t($ => $.responsibility.reason)} value={body} disabled={response.isPending} onChange={e => setBody(e.target.value)} />
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={response.isPending} onClick={() => response.mutate("accept")}>{t($ => $.responsibility.accept)}</Button>
        <Button size="sm" variant="outline" disabled={response.isPending || !body.trim()} onClick={() => response.mutate("return")}>{t($ => $.responsibility.return)}</Button></div>
    </>}
    {canReview && authorizeAgentId && delivery.status === "pending" && <Button size="sm" variant="outline" disabled={authorization.isPending} onClick={() => authorization.mutate(delivery.authorization ? null : authorizeAgentId)}>{delivery.authorization ? t($ => $.responsibility.revoke) : t($ => $.responsibility.authorize)}</Button>}
    {authorization.error && <p role="alert" className="text-destructive">{authorization.error.message}</p>}
    {response.error && <p role="alert" className="text-destructive">{response.error.message}</p>}
  </article>;
}
