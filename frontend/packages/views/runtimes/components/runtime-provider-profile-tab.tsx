"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentRuntime } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { runtimeProviderProfileOptions, useSetRuntimeProviderProfile, type RuntimeClaudeProfile } from "@multiremi/core/runtimes/provider-profile";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { useT } from "../../i18n";

export function RuntimeProviderProfileTab({ runtime, canManage, provider }: { runtime: AgentRuntime; canManage: boolean; provider: "codex" | "claude" }) {
  const wsId = useWorkspaceId();
  const profileKey = `${provider}_profile` as const;
  const { t } = useT("runtimes");
  const query = useQuery(runtimeProviderProfileOptions(wsId, runtime.id, provider));
  return <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-8">
    <header className="space-y-2">
      <h2 className="text-xl font-semibold">{t($ => $[profileKey].title)}</h2>
      <p className="text-sm leading-6 text-muted-foreground">{t($ => $[profileKey].description)}</p>
    </header>
    {query.isPending ? <p role="status">{t($ => $[profileKey].loading)}</p>
      : query.isError ? <div role="alert"><p>{t($ => $[profileKey].load_error)}</p><Button onClick={() => void query.refetch()}>{t($ => $[profileKey].retry)}</Button></div>
      : <ProfileForm key={`${wsId}:${runtime.id}:${JSON.stringify(query.data)}`} wsId={wsId} runtime={runtime} canManage={canManage} provider={provider} initial={query.data.profile} />}
  </div>;
}

function ProfileForm({ wsId, runtime, canManage, initial, provider }: { wsId: string; runtime: AgentRuntime; canManage: boolean; initial: RuntimeClaudeProfile | null; provider: "codex" | "claude" }) {
  const profileKey = `${provider}_profile` as const;
  const { t } = useT("runtimes");
  const prefix = useId();
  const [enabled, setEnabled] = useState(Boolean(initial));
  const [profile, setProfile] = useState<RuntimeClaudeProfile>(initial ?? { name: "custom", base_url: "", model: "", env_key: "", auth_mode: "api_key", ...(provider === "claude" ? { auth_header: "bearer" as const } : {}) });
  const [apiKey, setApiKey] = useState("");
  const save = useSetRuntimeProviderProfile(wsId, runtime.id, provider);
  const supported = runtime.metadata[`${provider}_profiles`] === 1;
  const editable = canManage && supported && !save.isPending;
  const fields = [
    { key: "name", label: t($ => $[profileKey].name), placeholder: "custom" },
    { key: "base_url", label: t($ => $[profileKey].base_url), placeholder: provider === "claude" ? "https://example.com" : "https://example.com/v1" },
    { key: "model", label: t($ => $[profileKey].model), placeholder: "my-model" },
  ] as const;
  return <form className="space-y-5 rounded-xl border bg-card p-5" onSubmit={event => {
    event.preventDefault();
    if (editable) save.mutate({ profile: enabled ? profile : null,
      ...(enabled && profile.auth_mode === "api_key" && apiKey ? { api_key: apiKey } : {}),
    }, { onSuccess: () => { setApiKey(""); toast.success(t($ => $[profileKey].saved)); } });
  }}>
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={`${prefix}-enabled`} className="text-sm font-medium">{t($ => $[profileKey].enabled)}</label>
      <Switch id={`${prefix}-enabled`} checked={enabled} onCheckedChange={setEnabled} disabled={!editable} />
    </div>
    {!supported && <p role="status" className="text-sm text-muted-foreground">{t($ => $[profileKey].update_required)}</p>}
    {enabled ? <>
      {fields.map(({ key, label, placeholder }) => <div className="space-y-2" key={key}>
        <label htmlFor={`${prefix}-${key}`} className="text-sm font-medium">{label}</label>
        <Input id={`${prefix}-${key}`} value={profile[key]} placeholder={placeholder} required disabled={!editable} autoComplete="off" spellCheck={false} onChange={event => setProfile(current => ({ ...current, [key]: event.target.value }))} />
      </div>)}
      <div className="space-y-2">
        <label htmlFor={`${prefix}-auth`} className="text-sm font-medium">{t($ => $[profileKey].auth)}</label>
        <NativeSelect id={`${prefix}-auth`} value={profile.auth_mode ?? "env"} disabled={!editable} onChange={event => {
          const auth_mode = event.target.value as "api_key" | "env";
          setApiKey("");
          setProfile(current => ({ ...current, auth_mode, env_key: auth_mode === "env" ? current.env_key || (provider === "codex" ? "REMI_CODEX_API_KEY" : "REMI_CLAUDE_API_KEY") : "" }));
        }}>
          <NativeSelectOption value="api_key">{t($ => $[profileKey].api_key)}</NativeSelectOption>
          <NativeSelectOption value="env">{t($ => $[profileKey].environment)}</NativeSelectOption>
        </NativeSelect>
      </div>
      {provider === "claude" && <div className="space-y-2">
        <label htmlFor={`${prefix}-header`} className="text-sm font-medium">{t($ => $.claude_profile.auth_header)}</label>
        <NativeSelect id={`${prefix}-header`} value={profile.auth_header ?? "bearer"} disabled={!editable} onChange={event => setProfile(current => ({ ...current, auth_header: event.target.value as "bearer" | "x-api-key" }))}>
          <NativeSelectOption value="bearer">Bearer Token</NativeSelectOption>
          <NativeSelectOption value="x-api-key">API Key (x-api-key)</NativeSelectOption>
        </NativeSelect>
      </div>}
      {profile.auth_mode === "api_key" ? <div className="space-y-2">
        <label htmlFor={`${prefix}-key`} className="text-sm font-medium">{t($ => $[profileKey].api_key)}</label>
        <Input id={`${prefix}-key`} type="password" autoComplete="new-password" value={apiKey} disabled={!editable} required={!initial?.credential_id} placeholder={initial?.credential_id ? t($ => $[profileKey].key_saved) : ""} onChange={event => setApiKey(event.target.value)} />
        <p className="text-sm leading-6 text-muted-foreground">{t($ => $[profileKey].key_hint)}</p>
      </div> : <div className="space-y-2">
        <label htmlFor={`${prefix}-env`} className="text-sm font-medium">{t($ => $[profileKey].env_key)}</label>
        <Input id={`${prefix}-env`} value={profile.env_key} required disabled={!editable} autoComplete="off" onChange={event => setProfile(current => ({ ...current, env_key: event.target.value }))} />
        <p className="text-sm leading-6 text-muted-foreground">{t($ => $[profileKey].credentials_hint)}</p>
      </div>}
    </> : <p className="text-sm text-muted-foreground">{t($ => $[profileKey].inherit)}</p>}
    <p className="text-sm leading-6 text-muted-foreground">{t($ => $[profileKey].sessions_hint)}</p>
    {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    {canManage && <Button type="submit" disabled={!editable}>{t($ => save.isPending ? $[profileKey].saving : $[profileKey].save)}</Button>}
  </form>;
}
