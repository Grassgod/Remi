"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { issueKeys } from "@multiremi/core/issues/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function IssueResponsibilityMigrationSection() {
  const { t } = useT("issues");
  const workspaceId = useWorkspaceId(), paths = useWorkspacePaths(), qc = useQueryClient();
  const [offset, setOffset] = useState(0), [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const { data: members = [] } = useQuery(memberListOptions(workspaceId));
  const migrationKey = [...issueKeys.all(workspaceId), "responsibility-migration"];
  const queryKey = [...migrationKey, offset];
  const facts = useQuery({ queryKey, queryFn: () => api.listIssueResponsibilityMigration(workspaceId, { limit: 100, offset }) });
  const map = useMutation({ mutationFn: () => api.mapIssueResponsibility(workspaceId, { reason: reason.trim(), mappings: (facts.data?.items ?? []).filter(item => selected[item.issueId]).map(item => ({ issueId: item.issueId, memberId: selected[item.issueId]!, revision: item.revision })) }),
    onSuccess: () => { setSelected({}); setReason(""); void qc.invalidateQueries({ queryKey: migrationKey }); void qc.invalidateQueries({ queryKey: issueKeys.all(workspaceId) }); },
    onError: () => { void facts.refetch(); },
  });
  const hasSelection = (facts.data?.items ?? []).some(item => selected[item.issueId]);
  return <section className="space-y-3 rounded border p-4">
    <h2 className="text-sm font-semibold">{t($ => $.responsibility.migration)}</h2>
    <p className="text-xs text-muted-foreground">{t($ => $.responsibility.migration_hint)}</p>
    {facts.isError && <Button variant="outline" onClick={() => void facts.refetch()}>{t($ => $.responsibility.load_failed)}</Button>}
    {facts.data && <>
      <p className="text-xs">{t($ => $.responsibility.migration_count, { total: facts.data.total, roots: facts.data.rootCount, legacy: facts.data.legacyMemberExecutionCount })}</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">{t($ => $.responsibility.source)}</th><th className="p-2">{t($ => $.responsibility.original_facts)}</th><th className="p-2">{t($ => $.responsibility.candidates)}</th><th className="p-2">{t($ => $.responsibility.human)}</th></tr></thead><tbody>
        {facts.data.items.map(item => <tr key={item.issueId} className="border-t align-top">
          <td className="p-2"><AppLink href={paths.issueDetail(item.issueId)}>{item.key} · {item.title}</AppLink></td>
          <td className="max-w-xs break-words p-2"><p>{item.assigneeType ?? "—"} · {item.assigneeId ?? "—"}</p><p>{t($ => $.responsibility.original_creator)}: {item.createdById ?? "—"}</p><p>{t($ => $.responsibility.human)}: {item.responsibleMemberId ?? "—"}</p><p>{t($ => $.responsibility.fact_revision)}: {item.revision}</p>{item.unresolved.map((problem, index) => <p key={index} className="text-destructive">{problem.issueId}: {problem.reason}</p>)}</td>
          <td className="max-w-xs p-2">{item.candidates.map(candidate => <p key={`${candidate.source}:${candidate.memberId}`}>{candidate.name} · {candidate.memberId}<br />{candidate.source === "legacy_member_assignee" ? t($ => $.responsibility.legacy_candidate) : candidate.source === "historical_creator" ? t($ => $.responsibility.creator_candidate) : candidate.source} · {candidate.available ? t($ => $.responsibility.needs_confirmation) : t($ => $.responsibility.unavailable)}</p>)}</td>
          <td className="p-2"><select aria-label={`${t($ => $.responsibility.human)} ${item.key}`} className="h-8 rounded border bg-background px-2" value={selected[item.issueId] ?? ""} disabled={map.isPending} onChange={event => setSelected(current => ({ ...current, [item.issueId]: event.target.value }))}><option value="">{t($ => $.responsibility.select)}</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></td>
        </tr>)}
      </tbody></table></div>
      <div className="flex gap-2"><Button variant="outline" disabled={offset === 0 || map.isPending} onClick={() => { setOffset(Math.max(0, offset - 100)); setSelected({}); }}>{t($ => $.responsibility.previous)}</Button><Button variant="outline" disabled={facts.data.nextOffset === null || map.isPending} onClick={() => { setOffset(facts.data!.nextOffset!); setSelected({}); }}>{t($ => $.responsibility.next)}</Button></div>
      <Textarea aria-label={t($ => $.responsibility.reason)} placeholder={t($ => $.responsibility.reason)} value={reason} onChange={event => setReason(event.target.value)} disabled={map.isPending} />
      {map.isError && <p role="alert" className="text-xs text-destructive">{map.error.message}</p>}
      <Button disabled={!hasSelection || !reason.trim() || map.isPending} onClick={() => map.mutate()}>{t($ => $.responsibility.map_selected)}</Button>
    </>}
  </section>;
}
