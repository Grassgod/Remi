"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UsageReport, SetUsagePriceInput } from "@multiremi/contracts/usage-accounting";
import { usagePricesOptions, useSetUsagePrice } from "@multiremi/core/usage/queries";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { useT } from "../../i18n";

type ModelKey = Pick<UsageReport["by_model"][number], "provider" | "model" | "connection_id"> & { requested_model_alias?: boolean };
const RATE_FIELDS = ["input_per_million", "output_per_million", "cache_read_per_million", "cache_write_per_million", "unsplit_per_million"] as const;
type Draft = Record<(typeof RATE_FIELDS)[number], string>;
const blank = (): Draft => ({ input_per_million: "", output_per_million: "", cache_read_per_million: "", cache_write_per_million: "", unsplit_per_million: "" });

export function UsagePricingDialog({ wsId, models, initial, onClose }: { wsId: string; models: ModelKey[]; initial?: ModelKey; onClose: () => void }) {
  const { t } = useT("usage");
  const query = useQuery(usagePricesOptions(wsId));
  const mutation = useSetUsagePrice(wsId);
  const prices = query.data ?? [];
  const [selection, setSelection] = useState<ModelKey>(initial ?? models.find(m => m.model !== null) ?? { provider: "", model: "", connection_id: null });
  const [draft, setDraft] = useState<Draft>(blank);
  const [currency, setCurrency] = useState("USD");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString());
  const [source, setSource] = useState<"configured" | "published">("configured");
  const [sourceUrl, setSourceUrl] = useState("");
  const [invalid, setInvalid] = useState(false);
  const key = JSON.stringify(selection);
  useEffect(() => {
    const current = prices.find(p => p.provider === selection.provider && p.model === selection.model && p.connection_id === selection.connection_id && p.requested_model_alias === Boolean(selection.requested_model_alias) && p.effective_to === null);
    setDraft(current ? Object.fromEntries(RATE_FIELDS.map(f => [f, current[f] === null ? "" : String(current[f])])) as Draft : blank());
    setCurrency(current?.currency ?? "USD"); setSource(current?.source === "published" ? "published" : "configured"); setSourceUrl(current?.source_url ?? "");
    setInvalid(false);
  // Query responses are authoritative; a failed mutation does not change them or reset the draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, query.data]);
  const choices = [...new Map([...models, ...prices.map(p => ({ provider: p.provider, model: p.model, connection_id: p.connection_id, requested_model_alias: p.requested_model_alias }))].filter(m => m.model !== null).map(m => [JSON.stringify(m), m])).values()];
  const labels = [t($ => $.table.input), t($ => $.table.output), t($ => $.table.cache_read), t($ => $.table.cache_write), t($ => $.table.unsplit)];
  const save = async () => {
    const rates = Object.fromEntries(RATE_FIELDS.map(f => [f, draft[f].trim() === "" ? null : Number(draft[f])])) as Pick<SetUsagePriceInput, (typeof RATE_FIELDS)[number]>;
    if (!selection.provider.trim() || !selection.model?.trim() || !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(Date.parse(effectiveFrom))
      || Object.values(rates).some(v => v !== null && (!Number.isFinite(v) || v < 0)) || (source === "published" && !/^https?:\/\//.test(sourceUrl))) { setInvalid(true); return; }
    try { await mutation.mutateAsync({ ...rates, provider: selection.provider, model: selection.model, connection_id: selection.connection_id, requested_model_alias: Boolean(selection.requested_model_alias),
      currency, source, source_url: source === "published" ? sourceUrl : null, effective_from: new Date(effectiveFrom).toISOString(), effective_to: null }); onClose(); }
    catch { /* Preserve fields and display mutation failure. */ }
  };
  const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{t($ => $.price.title)}</DialogTitle><DialogDescription>{t($ => $.price.description)}</DialogDescription></DialogHeader>
      {query.isError ? <div role="alert" className="text-sm text-destructive">{t($ => $.error.body)} <Button variant="outline" onClick={() => query.refetch()}>{t($ => $.error.retry)}</Button></div> : null}
      {choices.length > 0 && <label className="space-y-1 text-xs">{t($ => $.price.model)}<select className={selectClass} value={choices.some(c => JSON.stringify(c) === key) ? key : ""} onChange={e => { const choice = choices.find(c => JSON.stringify(c) === e.target.value); if (choice) setSelection(choice); }}>
        <option value="">—</option>{choices.map(m => <option key={JSON.stringify(m)} value={JSON.stringify(m)}>{m.provider} · {m.model} · {m.connection_id ?? "—"}</option>)}
      </select></label>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs">{t($ => $.price.provider)}<Input value={selection.provider} onChange={e => setSelection(s => ({ ...s, provider: e.target.value }))} /></label>
        <label className="space-y-1 text-xs">{t($ => $.price.model)}<Input value={selection.model ?? ""} onChange={e => setSelection(s => ({ ...s, model: e.target.value }))} /></label>
        <label className="space-y-1 text-xs">{t($ => $.price.connection)}<Input value={selection.connection_id ?? ""} onChange={e => setSelection(s => ({ ...s, connection_id: e.target.value || null }))} /></label>
      </div>
      <p className="text-xs text-muted-foreground">{t($ => $.price.rates)}</p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(selection.requested_model_alias)} onChange={e => { setSelection(s => ({ ...s, requested_model_alias: e.target.checked })); if (e.target.checked) setSource("configured"); }} />{t($ => $.price.requested_alias)}</label>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{RATE_FIELDS.map((f, i) => <label key={f} className="space-y-1 text-xs">{labels[i]}<Input type="number" min="0" step="any" value={draft[f]} onChange={e => setDraft(d => ({ ...d, [f]: e.target.value }))} placeholder="—" /></label>)}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">{t($ => $.price.currency)}<Input value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} /></label>
        <label className="space-y-1 text-xs">{t($ => $.price.effective_from)}<Input value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></label>
        <label className="space-y-1 text-xs">{t($ => $.price.source)}<select className={selectClass} value={source} onChange={e => setSource(e.target.value === "published" ? "published" : "configured")}><option value="configured">{t($ => $.price.configured)}</option><option value="published" disabled={selection.requested_model_alias}>{t($ => $.price.published)}</option></select></label>
        {source === "published" && <label className="space-y-1 text-xs">{t($ => $.price.source_url)}<Input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} /></label>}
      </div>
      {invalid && <p role="alert" className="text-sm text-destructive">{t($ => $.price.invalid)}</p>}
      {mutation.isError && <p role="alert" className="text-sm text-destructive">{t($ => $.price.save_error)}</p>}
      <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm">{t($ => $.price.history)}</summary><div className="mt-3 space-y-2 text-xs">
        {prices.filter(p => p.provider === selection.provider && p.model === selection.model && p.connection_id === selection.connection_id).map(p => <div key={p.id} className="space-y-1 rounded bg-muted/40 p-2"><div>{p.effective_from} → {p.effective_to ?? "∞"} · {p.currency} · {p.source === "published" ? t($ => $.price.published) : t($ => $.price.configured)}</div><div>{RATE_FIELDS.map((f,i) => `${labels[i]} ${p[f] ?? "—"}`).join(" · ")}</div><code className="break-all">{p.id}</code></div>)}
      </div></details>
      <DialogFooter><Button variant="outline" onClick={onClose} disabled={mutation.isPending}>{t($ => $.price.cancel)}</Button><Button onClick={save} disabled={mutation.isPending || query.isLoading}>{t($ => $.price.save)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
