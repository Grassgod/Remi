"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UsageMetrics } from "@multiremi/contracts/usage-accounting";
import { usageReportOptions } from "@multiremi/core/usage/queries";
import { projectListOptions } from "@multiremi/core/projects/queries";
import { agentListOptions } from "@multiremi/core/workspace/queries";
import { runtimeListOptions } from "@multiremi/core/runtimes/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { StackedBarChart } from "../runtimes/components/charts/stacked-bar-chart";
import { UsagePricingDialog } from "../runtimes/components/custom-pricing-dialog";
import { useViewingTimezone } from "../common/use-viewing-timezone";
import { formatTokens } from "../common/format";
import { useT } from "../i18n";
import { formatKnownCost, hasKnownTokens, tokenCoverage, trendRows, taskTrendRows, usageCsv } from "./utils";

type View = "daily" | "agents" | "models" | "runtimes";
type PricingModel = { provider: string; model: string | null; connection_id: string | null; requested_model_alias: boolean };
const TOKEN_SERIES = ["input", "output", "cacheRead", "cacheWrite", "unsplit"];
const selectClass = "h-8 rounded-md border bg-background px-2 text-xs";

export function UsagePanel(props: { wsId: string; runtimeId?: string }) {
  return <UsagePanelContent key={`${props.wsId}:${props.runtimeId ?? "all"}`} {...props} />;
}

function UsagePanelContent({ wsId, runtimeId }: { wsId: string; runtimeId?: string }) {
  const { t } = useT("usage");
  const tz = useViewingTimezone();
  const [days, setDays] = useState<number | "all">(30);
  const [projectId, setProjectId] = useState("");
  const [selectedRuntime, setSelectedRuntime] = useState("");
  const [weekly, setWeekly] = useState(false);
  const [view, setView] = useState<View>("daily");
  const [metric, setMetric] = useState<"tokens" | "cost" | "tasks" | "time">("tokens");
  const [currency, setCurrency] = useState("");
  const [pricing, setPricing] = useState<{ initial?: PricingModel } | null>(null);
  const projectsQuery = useQuery(projectListOptions(wsId));
  const agentsQuery = useQuery(agentListOptions(wsId));
  const runtimesQuery = useQuery({ ...runtimeListOptions(wsId), enabled: Boolean(wsId) && !runtimeId });
  // Selections are scoped by workspace. A deleted or previous-workspace ID must
  // never silently change a visible "All" filter into an empty report.
  const project = projectsQuery.data?.some(p => p.id === projectId) ? projectId : null;
  const runtime = runtimeId ?? (runtimesQuery.data?.some(r => r.id === selectedRuntime) ? selectedRuntime : null);
  const query = useQuery(usageReportOptions(wsId, { days, tz, project_id: project, runtime_id: runtime }));
  const report = query.data;
  const currencies = Object.keys(report?.summary.known_cost_by_currency ?? {}).sort();
  const effectiveCurrency = currencies.includes(currency) ? currency : currencies[0] ?? "USD";
  const trend = useMemo(() => report ? trendRows(report, weekly, effectiveCurrency) : [], [report, weekly, effectiveCurrency]);
  const taskTrend = useMemo(() => report ? taskTrendRows(report, weekly) : [], [report, weekly]);
  const models: PricingModel[] = report?.by_model.filter(m => m.model !== null || m.requested_model !== null).map(m => ({ provider: m.provider,
    model: m.model ?? m.requested_model, connection_id: m.connection_id, requested_model_alias: m.model === null })) ?? [];
  const tokenLabels = [t($ => $.table.input), t($ => $.table.output), t($ => $.table.cache_read), t($ => $.table.cache_write), t($ => $.table.unsplit)];
  const config = metric === "tokens" ? Object.fromEntries(TOKEN_SERIES.map((key,i) => [key, { label: tokenLabels[i], color: `var(--chart-${i + 1})` }]))
    : metric === "cost" ? { cost: { label: `${t($ => $.summary.known_cost)} · ${effectiveCurrency}`, color: "var(--chart-1)" } }
    : metric === "time" ? { seconds: { label: t($ => $.summary.run_time), color: "var(--chart-1)" } }
    : { completed: { label: t($ => $.statuses.completed), color: "var(--chart-1)" }, failed: { label: t($ => $.statuses.failed), color: "var(--chart-2)" }, cancelled: { label: t($ => $.statuses.cancelled), color: "var(--chart-3)" }, active: { label: t($ => $.statuses.active), color: "var(--chart-4)" }, queued: { label: t($ => $.statuses.queued), color: "var(--chart-5)" } };
  const viewLabels: Record<View,string> = { daily: t($ => $.views.daily), agents: t($ => $.views.agents), models: t($ => $.views.models), runtimes: t($ => $.views.runtimes) };
  const statusLabels = { completed: t($ => $.statuses.completed), failed: t($ => $.statuses.failed), cancelled: t($ => $.statuses.cancelled), active: t($ => $.statuses.active), queued: t($ => $.statuses.queued) };
  const runtimeSources: Record<string, string> = { live_task: t($ => $.common.scope_live), task_record: t($ => $.common.scope_task_record), trace_owner: t($ => $.common.scope_trace_owner), archive_manifest: t($ => $.common.scope_archive), unknown: t($ => $.common.scope_unknown), mixed: t($ => $.common.scope_mixed) };
  const rows = report ? view === "daily" ? report.daily.map(m => ({ key: m.date, label: m.date, metrics: m }))
    : view === "agents" ? report.by_agent.map(m => ({ key: m.agent_id, label: agentsQuery.data?.find(a => a.id === m.agent_id)?.name ?? m.agent_id, metrics: m }))
    : view === "runtimes" ? report.by_runtime.map(m => ({ key: m.runtime_id ?? "__none__", label: runtimesQuery.data?.find(r => r.id === m.runtime_id)?.name ?? m.runtime_id ?? t($ => $.common.no_runtime), note: runtimeSources[m.runtime_provenance] ?? t($ => $.common.scope_unknown), metrics: m }))
    : report.by_model.map(m => ({ key: JSON.stringify([m.provider,m.model,m.requested_model,m.model_provenance,m.purpose,m.connection_id]), label: `${m.provider} · ${m.model ?? m.requested_model ?? t($ => $.price.unknown_model)}`, metrics: m,
      note: m.model_source === "requested" ? t($ => $.price.requested_model) : m.model_source === "unknown" ? t($ => $.price.unknown_model) : t($ => $.price.reported_model), requested: m.requested_model, provenance: m.model_provenance === "provider_reported" ? t($ => $.price.reported_model) : m.model_provenance === "session_acknowledged" ? t($ => $.price.session_model) : m.model_provenance === "configured" ? t($ => $.price.configured_model) : t($ => $.price.unknown_model),
      purpose: m.purpose, provider: m.provider, actualModel: m.model, modelProvenance: m.model_provenance, connection: m.connection_id, pricingModel: (m.model ?? m.requested_model) ? { provider: m.provider, model: m.model ?? m.requested_model, connection_id: m.connection_id, requested_model_alias: m.model === null } : undefined })) : [];
  const tokenValue = (m: UsageMetrics, value: number) => value === 0 && m.unknown_task_count > 0 ? "—" : formatTokens(value);
  const pct = (m: UsageMetrics) => { const ratio = tokenCoverage(m); return ratio === null ? "—" : `${(ratio * 100).toFixed(1)}%`; };
  const canDraw = metric === "tasks" || metric === "time" ? taskTrend.length > 0 : trend.some(r => metric === "cost" ? r.cost !== null : r.input !== null || r.unsplit !== null);
  const download = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF", usageCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `usage-${view}-${report?.as_of.slice(0,10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <section className="space-y-5" aria-label={t($ => $.title)}>
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t($ => $.filter.project)}<select className={`${selectClass} max-w-56 text-foreground`} value={project ?? ""} onChange={e => setProjectId(e.target.value)}><option value="">{t($ => $.filter.all_projects)}</option>{projectsQuery.data?.map(p => <option value={p.id} key={p.id}>{p.title}</option>)}</select></label>
      {!runtimeId && <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t($ => $.filter.runtime)}<select className={`${selectClass} max-w-56 text-foreground`} value={runtime ?? ""} onChange={e => setSelectedRuntime(e.target.value)}><option value="">{t($ => $.filter.all_runtimes)}</option>{runtimesQuery.data?.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}</select></label>}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t($ => $.filter.period)}<select className={`${selectClass} text-foreground`} value={days} onChange={e => { const value = e.target.value; setDays(value === "all" ? "all" : Number(value)); if (value === "all" || Number(value) >= 180) setWeekly(true); }}>{[1,7,30,90,180,365].map(d => <option value={d} key={d}>{d}D</option>)}<option value="all">{t($ => $.filter.all_history)}</option></select></label>
      <Button variant="outline" size="sm" onClick={() => setPricing({})}>{t($ => $.price.open)}</Button>
      <Button variant="ghost" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>{t($ => $.common.refresh)}</Button>
    </div>
    {query.isLoading && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0,1,2,3].map(i => <Skeleton key={i} className="h-28" />)}</div>}
    {query.isError && <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 p-5"><h3 className="font-semibold">{t($ => $.error.title)}</h3><p className="text-sm text-muted-foreground">{t($ => $.error.body)}</p><Button variant="outline" onClick={() => query.refetch()}>{t($ => $.error.retry)}</Button></div>}
    {!query.isError && report && <>
      {report.summary.task_count === 0 && <div className="rounded-lg border p-5"><h3 className="font-semibold">{t($ => $.empty.title)}</h3><p className="text-sm text-muted-foreground">{t($ => $.empty.body)}</p></div>}
      <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-lg border lg:grid-cols-4">
        <MetricCard label={t($ => $.summary.actual)} value={hasKnownTokens(report.summary) ? formatTokens(report.summary.actual_total_tokens) : "—"} />
<MetricCard label={t($ => $.summary.known_cost)} value={formatKnownCost(report.summary)} hint={report.summary.price_quality === "provider_reported" ? t($ => $.price.provider_reported) : report.summary.price_quality === "configured" ? t($ => $.price.configured) : report.summary.price_quality === "published" ? t($ => $.price.published) : report.summary.price_quality === "mixed" ? t($ => $.price.mixed) : t($ => $.price.unknown)} />
        <MetricCard label={t($ => $.summary.coverage)} value={pct(report.summary)} hint={`${formatTokens(report.summary.priced_tokens)} / ${formatTokens(report.summary.actual_total_tokens)}`} />
        <MetricCard label={t($ => $.summary.unknown)} value={String(report.summary.unknown_task_count)} />
      </div>
      <p className="text-xs text-muted-foreground">{report.summary.complete ? t($ => $.summary.complete) : t($ => $.summary.partial)}</p>
      {Object.keys(report.summary.reference_cost_by_currency ?? {}).length > 0 && <div className="rounded-lg border px-4 py-3 text-xs"><span>{t($ => $.summary.reference_cost)} <strong>{Object.entries(report.summary.reference_cost_by_currency ?? {}).map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(" · ")}</strong></span><p className="mt-1 text-muted-foreground">{t($ => $.summary.reference_hint)}</p></div>}
      {Object.keys(report.summary.sdk_estimate_cost_by_currency ?? {}).length > 0 && <div className="rounded-lg border px-4 py-3 text-xs"><span>{t($ => $.summary.sdk_estimate)} <strong>{Object.entries(report.summary.sdk_estimate_cost_by_currency ?? {}).map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(" · ")}</strong></span><p className="mt-1 text-muted-foreground">{t($ => $.summary.reference_hint)}</p></div>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border px-4 py-3 text-xs"><span>{t($ => $.summary.tasks)} <strong>{report.summary.task_count}</strong></span>{Object.entries(statusLabels).map(([status,label]) => <span key={status}>{label} <strong>{report.summary.status_counts[status as keyof typeof statusLabels]}</strong></span>)}<span>{t($ => $.summary.run_time)} <strong>{`${Math.round(report.summary.total_seconds / 60).toLocaleString()}m`}</strong></span></div>
      <p className="text-xs text-muted-foreground">{t($ => $.summary.time_hint)}</p>
      <div className="rounded-lg border px-4 py-3 text-xs"><span>{t($ => $.summary.context)} <strong>{report.summary.context_peak_tokens === null ? "—" : formatTokens(report.summary.context_peak_tokens)}</strong></span><p className="mt-1 text-muted-foreground">{t($ => $.summary.context_hint)}</p></div>
      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-3"><h3 className="mr-auto text-sm font-semibold">{t($ => $.trend.title)}</h3><select className={selectClass} aria-label={t($ => $.filter.dimension)} value={weekly ? "weekly" : "daily"} onChange={e => setWeekly(e.target.value === "weekly")}><option value="daily">{t($ => $.filter.daily)}</option><option value="weekly">{t($ => $.filter.weekly)}</option></select><select className={selectClass} aria-label={t($ => $.trend.title)} value={metric} onChange={e => setMetric(e.target.value as typeof metric)}><option value="tokens">{t($ => $.trend.tokens)}</option><option value="cost">{t($ => $.trend.cost)}</option><option value="tasks">{t($ => $.summary.tasks)}</option><option value="time">{t($ => $.summary.run_time)}</option></select>{metric === "cost" && currencies.length > 1 && <select className={selectClass} aria-label={t($ => $.price.currency)} value={effectiveCurrency} onChange={e => setCurrency(e.target.value)}>{currencies.map(c => <option key={c}>{c}</option>)}</select>}</div>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">{metric === "tokens" ? TOKEN_SERIES.map((key,i) => <span key={key} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: `var(--chart-${i + 1})` }} />{tokenLabels[i]}</span>) : metric === "cost" ? `${t($ => $.summary.known_cost)} · ${effectiveCurrency}` : metric === "time" ? t($ => $.summary.run_time) : Object.values(statusLabels).join(" · ")}</div>
        {canDraw ? <StackedBarChart data={metric === "tasks" || metric === "time" ? taskTrend : trend} config={config} series={metric === "tokens" ? TOKEN_SERIES : metric === "tasks" ? Object.keys(statusLabels) : metric === "time" ? ["seconds"] : ["cost"]} stackId="usage" yAxisWidth={60} yAxisTickFormatter={metric === "tokens" ? formatTokens : metric === "time" ? v => `${Math.round(v / 60)}m` : metric === "tasks" ? v => String(v) : v => v.toFixed(2)} formatValue={metric === "tokens" ? formatTokens : metric === "time" ? v => `${Math.round(v / 60)}m` : metric === "tasks" ? v => String(v) : v => `${effectiveCurrency} ${v.toFixed(2)}`} /> : <p className="py-10 text-center text-sm text-muted-foreground">{t($ => $.trend.unknown)}</p>}
        {(metric === "tasks" || metric === "time") && <p className="text-xs text-muted-foreground">{t($ => $.summary.time_hint)}</p>}{metric === "cost" && <p className="text-xs text-muted-foreground">{t($ => $.trend.subtotal_hint)}</p>}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="flex flex-wrap gap-1 border-b p-3">{(Object.keys(viewLabels) as View[]).map(v => <Button key={v} size="sm" variant={view === v ? "secondary" : "ghost"} aria-pressed={view === v} onClick={() => setView(v)}>{viewLabels[v]}</Button>)}<Button className="ml-auto" size="sm" variant="outline" onClick={download}>{t($ => $.common.export_csv)}</Button></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[1250px] text-xs"><thead className="border-b bg-muted/30"><tr>{[t($ => $.table.group),t($ => $.table.total),...tokenLabels,t($ => $.table.context),t($ => $.table.cost),t($ => $.table.coverage),t($ => $.table.unknown),t($ => $.table.tasks)].map(label => <th key={label} className="whitespace-nowrap px-3 py-3 text-left font-medium text-muted-foreground">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.key} className="border-b last:border-b-0"><td className="max-w-64 px-3 py-3"><div className="truncate font-medium" title={row.label}>{row.label}</div>{"note" in row && row.note && <div className="mt-1 text-muted-foreground">{row.note}</div>}{"purpose" in row && row.purpose === "progress_summary" && <div className="mt-1 text-muted-foreground">{t($ => $.price.progress_summary)}</div>}{"requested" in row && row.requested && <div className="mt-1 truncate text-muted-foreground" title={row.requested}>{t($ => $.price.requested)}: {row.requested}</div>}{"provenance" in row && <div className="mt-1 text-muted-foreground">{row.provenance}</div>}{"connection" in row && row.connection && <div className="mt-1 truncate font-mono text-muted-foreground" title={row.connection}>{row.connection}</div>}{"pricingModel" in row && row.pricingModel && <button type="button" className="mt-1 text-brand hover:underline" onClick={() => setPricing({ initial: row.pricingModel })}>{t($ => $.price.open)}</button>}</td>
          {[row.metrics.actual_total_tokens,row.metrics.actual_input_tokens,row.metrics.actual_output_tokens,row.metrics.actual_cache_read_tokens,row.metrics.actual_cache_write_tokens,row.metrics.actual_unsplit_tokens].map((n,i) => <td key={i} className="whitespace-nowrap px-3 py-3 font-mono tabular-nums">{tokenValue(row.metrics,n)}</td>)}
          <td className="px-3 py-3 font-mono">{row.metrics.context_peak_tokens === null ? "—" : formatTokens(row.metrics.context_peak_tokens)}</td><td className="whitespace-nowrap px-3 py-3 font-mono">{formatKnownCost(row.metrics)}</td><td className="px-3 py-3 font-mono">{pct(row.metrics)}</td><td className="px-3 py-3 font-mono">{row.metrics.unknown_task_count}</td><td className="px-3 py-3 font-mono">{row.metrics.task_count}</td>
        </tr>)}</tbody></table></div>
        <p className="border-t px-3 py-3 text-xs text-muted-foreground">{t($ => $.views.counts_hint)}</p>
      </div>
      <p className="text-xs text-muted-foreground">{t($ => $.common.updated)} {report.as_of} · {tz} · {t($ => $.common.price_revision)} {report.pricing_revision}</p>
    </>}
    {pricing && <UsagePricingDialog wsId={wsId} models={models} initial={pricing.initial} onClose={() => setPricing(null)} />}
  </section>;
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="min-w-0 space-y-2 p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="break-words text-2xl font-semibold tabular-nums">{value}</div>{hint && <div className="text-xs text-muted-foreground">{hint}</div>}</div>;
}
