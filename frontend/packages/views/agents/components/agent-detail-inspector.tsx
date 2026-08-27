"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2, Pencil } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, MemberWithUser } from "@multiremi/core/types";
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  type AgentPresenceDetail,
} from "@multiremi/core/agents";
import { useAuthStore } from "@multiremi/core/auth";
import { larkInstallationsOptions } from "@multiremi/core/lark";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useFleetProviderModels } from "@multiremi/core/runtimes";
import { isImeComposing } from "@multiremi/core/utils";
import { useTimeAgo } from "../../i18n";
import { Button } from "@multiremi/ui/components/ui/button";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { ActorAvatar } from "../../common/actor-avatar";
import { AvatarUploadButton } from "../../common/avatar-upload-button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multiremi/ui/components/ui/popover";
import { PropRow } from "../../common/prop-row";
import { availabilityConfig } from "../presence";
import { CharCounter } from "./char-counter";
import { useT } from "../../i18n";
import { ConcurrencyPicker } from "./inspector/concurrency-picker";
import { EnginePicker } from "./inspector/engine-picker";
import { ModelPicker } from "./inspector/model-picker";
import { SkillAttach } from "./inspector/skill-attach";
import { ThinkingPropRow } from "./inspector/thinking-prop-row";
import { supportsThinkingLevel } from "./inspector/thinking-levels";
import { VisibilityPicker } from "./inspector/visibility-picker";
import { LarkAgentBindButton } from "../../settings/components/lark-tab";

interface InspectorProps {
  agent: Agent;
  owner: MemberWithUser | null;
  presence: AgentPresenceDetail | null | undefined;
  /**
   * Computed by the parent via `useAgentPermissions(agent).canEdit.allowed`.
   * When false the inspector renders all editable surfaces as static
   * read-only displays — pickers become text/badges, name/description lose
   * their pencil affordance, the avatar is no longer clickable, and the
   * "Attach skill" trigger is hidden. Mirrors the backend gate at
   * `server/internal/handler/agent.go:519-535`.
   */
  canEdit: boolean;
  /** Only workspace owners/admins can grant cross-task supervisor authority. */
  canManageSupervisor: boolean;
  onUpdate: (id: string, data: Record<string, unknown>) => Promise<void>;
  onSetSupervisor: (id: string, enabled: boolean) => Promise<void>;
  /**
   * Focus the overview pane's Integrations tab. The inspector's Lark status
   * row is read-only and deep-links here; Manage / Disconnect live in the
   * tab so the destructive action exists in exactly one place.
   */
  onShowIntegrations: () => void;
}

/**
 * Left 320px column of the agent detail page. Holds the agent's identity card
 * (avatar / name / description / status), inline-editable properties, and
 * skills.
 *
 * Quick single-field edits happen here — there is no separate Settings tab.
 * The explicit "Edit Agent" action opens the consolidated metadata dialog for
 * users who want to review several fields before saving them together.
 */
export function AgentDetailInspector({
  agent,
  owner,
  presence,
  canEdit,
  canManageSupervisor,
  onUpdate,
  onSetSupervisor,
  onShowIntegrations,
}: InspectorProps) {
  const { t } = useT("agents");
  const timeAgo = useTimeAgo();
  const wsId = useWorkspaceId();
  const update = (data: Record<string, unknown>) => onUpdate(agent.id, data);
  const provider = agent.provider || "claude";
  const { models } = useFleetProviderModels(wsId ?? "", provider);
  const showIntegrations = useHasIntegrations(agent.id);
  const [supervisorSaving, setSupervisorSaving] = useState(false);
  const switchEngine = (next: string) =>
    update({ provider: next, model: "", thinking_level: "" });
  const switchModel = (next: string) => {
    const data: Record<string, unknown> = { model: next };
    if (
      next !== (agent.model ?? "") &&
      !supportsThinkingLevel(models, next, agent.thinking_level ?? "")
    ) {
      data.thinking_level = "";
    }
    return update(data);
  };

  return (
    <aside className="flex w-full flex-col rounded-lg border bg-background md:h-full md:min-h-0 md:overflow-y-auto">
      {/* Identity */}
      <div className="flex flex-col gap-3 border-b px-5 pb-5 pt-5">
        <AvatarEditor agent={agent} canEdit={canEdit} onUpdate={update} />
        <NameAndDescription
          agent={agent}
          canEdit={canEdit}
          onUpdate={update}
        />
        <PresenceBadge presence={presence} />
      </div>

      {/* Properties — editable when canEdit. When the current user lacks
          permission, each picker self-renders a static read-only display so
          the value is visible but not interactive. */}
      <Section label={t(($) => $.inspector.section_properties)}>
        <PropRow label={t(($) => $.inspector.prop_engine)} interactive={false}>
          <EnginePicker
            value={provider}
            canEdit={canEdit}
            onChange={switchEngine}
          />
        </PropRow>
        <PropRow label={t(($) => $.inspector.prop_model)} interactive={false}>
          <ModelPicker
            wsId={wsId ?? ""}
            provider={provider}
            value={agent.model ?? ""}
            canEdit={canEdit}
            onChange={switchModel}
          />
        </PropRow>
        <ThinkingPropRow
          wsId={wsId ?? ""}
          provider={provider}
          model={agent.model ?? ""}
          value={agent.thinking_level ?? ""}
          canEdit={canEdit}
          onChange={(v) => update({ thinking_level: v })}
        />
        <PropRow label={t(($) => $.inspector.prop_visibility)} interactive={false}>
          <VisibilityPicker
            value={agent.visibility}
            canEdit={canEdit}
            onChange={(v) => update({ visibility: v })}
          />
        </PropRow>
        <PropRow label={t(($) => $.inspector.prop_concurrency)} interactive={false}>
          <ConcurrencyPicker
            value={agent.max_concurrent_tasks}
            canEdit={canEdit}
            onChange={(n) => update({ max_concurrent_tasks: n })}
          />
        </PropRow>
        <PropRow label={t(($) => $.inspector.prop_supervisor)} interactive={false}>
          <span
            id={`agent-supervisor-hint-${agent.id}`}
            className="mr-auto text-muted-foreground"
          >
            {agent.supervisor === true
              ? t(($) => $.inspector.supervisor_enabled)
              : t(($) => $.inspector.supervisor_disabled)}
          </span>
          <Switch
            size="sm"
            checked={agent.supervisor === true}
            disabled={!canManageSupervisor || supervisorSaving}
            aria-label={t(($) => $.inspector.prop_supervisor)}
            aria-describedby={`agent-supervisor-hint-${agent.id}`}
            onCheckedChange={(enabled) => {
              setSupervisorSaving(true);
              void onSetSupervisor(agent.id, enabled).finally(() => {
                setSupervisorSaving(false);
              });
            }}
          />
        </PropRow>
      </Section>

      {/* Details — read-only (no hover, no chip styling — these aren't clickable) */}
      <Section label={t(($) => $.inspector.section_details)}>
        {owner && (
          <PropRow label={t(($) => $.inspector.prop_owner)} interactive={false}>
            <span className="flex min-w-0 items-center gap-1.5">
              <ActorAvatar
                actorType="member"
                actorId={owner.user_id}
                size={14}
              />
              <span className="truncate">{owner.name}</span>
            </span>
          </PropRow>
        )}
        <PropRow label={t(($) => $.inspector.prop_created)} interactive={false}>
          <span className="text-muted-foreground">
            {timeAgo(agent.created_at)}
          </span>
        </PropRow>
        <PropRow label={t(($) => $.inspector.prop_updated)} interactive={false}>
          <span className="text-muted-foreground">
            {timeAgo(agent.updated_at)}
          </span>
        </PropRow>
      </Section>

      {/* Skills */}
      <div className="flex flex-col border-b px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t(($) => $.inspector.section_skills)}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {agent.skills.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {/* SkillAttach self-hides for viewers and when the workspace has
              nothing left to attach, so a skill-less agent would otherwise
              render an empty zero-height row under the "Skills 0" header. */}
          {agent.skills.length === 0 && (
            <span className="text-xs italic text-muted-foreground/70">
              {t(($) => $.inspector.skills_empty)}
            </span>
          )}
          {agent.skills.map((s) => (
            <span
              key={s.id}
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
            >
              {s.name}
            </span>
          ))}
          <SkillAttach agent={agent} canEdit={canEdit} />
        </div>
      </div>

      {/* Integrations — surfaces external-channel bind entry points
          (Lark Bot today; Slack / Discord in the future). We only mount it
          for editors: viewers shouldn't see a CTA they can't action.
          `showIntegrations` mirrors LarkAgentBindButton's own visibility
          rules so the header never renders above a button that self-hid —
          the button keeps its own gate, this one only decides whether the
          section is worth a heading. */}
      {canEdit && showIntegrations && (
        <div className="flex flex-col px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t(($) => $.inspector.section_integrations)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <LarkAgentBindButton
              agentId={agent.id}
              agentName={agent.name}
              onShowConnectedDetails={onShowIntegrations}
            />
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * Whether the Integrations section has anything to show for this agent.
 *
 * Recomputes the visibility rules `LarkAgentBindButton` applies to itself
 * (`settings/components/lark-tab.tsx`): workspace owner/admin only, then
 * either an existing active installation for this agent or a deployment
 * where fresh scan-installs can complete. Without it the section header
 * renders above a button that returned null — an "INTEGRATIONS" heading
 * with nothing under it, which is the common case for an agent owner who
 * is a plain workspace member.
 *
 * Both queries are already in the cache on this page (the bind button and
 * the overview pane request the same keys), so this costs no extra round
 * trip. Every field is optional-chained: an older server that omits
 * `install_supported` degrades to "no bind CTA", matching the button.
 */
function useHasIntegrations(agentId: string): boolean {
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);

  const { data: listing } = useQuery({
    ...larkInstallationsOptions(wsId ?? ""),
    enabled: !!wsId,
  });
  const { data: members = [] } = useQuery({
    ...memberListOptions(wsId ?? ""),
    enabled: !!wsId,
  });

  const role = members.find((m) => m.user_id === user?.id)?.role;
  if (role !== "owner" && role !== "admin") return false;

  const hasActiveInstall =
    listing?.installations?.some(
      (inst) => inst.agent_id === agentId && inst.status === "active",
    ) === true;

  return hasActiveInstall || listing?.install_supported === true;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b px-5 py-4">
      <div className="mb-1 -mx-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity — avatar / name / description editors
// ---------------------------------------------------------------------------

function AvatarEditor({
  agent,
  canEdit,
  onUpdate,
}: {
  agent: Agent;
  canEdit: boolean;
  onUpdate: (data: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useT("agents");

  if (!canEdit) {
    return (
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg">
        <ActorAvatar
          actorType="agent"
          actorId={agent.id}
          size={56}
          className="rounded-none"
        />
      </div>
    );
  }

  return (
    <AvatarUploadButton
      // rounded-lg matches the standard agent avatar treatment used in
      // list rows. Avoid rounded-full — circles are reserved for humans.
      className="h-14 w-14 rounded-lg"
      ariaLabel={t(($) => $.inspector.change_avatar_aria)}
      successMessage={t(($) => $.inspector.avatar_updated_toast)}
      errorMessage={t(($) => $.inspector.avatar_upload_failed_toast)}
      onUploaded={(url) => onUpdate({ avatar_url: url })}
    >
      <ActorAvatar
        actorType="agent"
        actorId={agent.id}
        size={56}
        className="rounded-none"
      />
    </AvatarUploadButton>
  );
}

function NameAndDescription({
  agent,
  canEdit,
  onUpdate,
}: {
  agent: Agent;
  canEdit: boolean;
  onUpdate: (data: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useT("agents");
  if (!canEdit) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold leading-tight">
          {agent.name}
        </span>
        {agent.description ? (
          <span className="text-xs leading-relaxed text-muted-foreground">
            {agent.description}
          </span>
        ) : (
          <span className="text-xs italic leading-relaxed text-muted-foreground/50">
            {t(($) => $.inspector.no_description_placeholder)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <InlineEditPopover
        value={agent.name}
        onSave={(v) => onUpdate({ name: v.trim() })}
        kind="input"
        title={t(($) => $.inspector.rename_title)}
        placeholder={t(($) => $.inspector.rename_placeholder)}
        validate={(v) => (v.trim().length > 0 ? null : t(($) => $.inspector.rename_required))}
      >
        {(triggerProps) => (
          <button
            type="button"
            {...triggerProps}
            className="group -mx-1 inline-flex items-center gap-1.5 self-start rounded px-1 text-left text-base font-semibold leading-tight transition-colors hover:bg-accent/50"
          >
            <span>{agent.name}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </button>
        )}
      </InlineEditPopover>

      <DescriptionEditor
        value={agent.description ?? ""}
        onSave={(v) => onUpdate({ description: v })}
      />
    </div>
  );
}

// Description editor — modal because the description benefits from a roomy
// composition surface (the inline popover was 288 px wide × 3 rows, too
// cramped to read or edit anything substantial). Name stays in the inline
// popover above: a single line is the right shape for it.
//
// The editor body is split into a child component that mounts only while
// the dialog is open. That way the draft state is initialised from `value`
// at mount time and never reset by an external update mid-edit — closing
// the dialog unmounts the body, reopening starts fresh with the latest
// value. This is the React-recommended replacement for the
// `useEffect(reset, [value])` anti-pattern (see "You Might Not Need an
// Effect" — Resetting state with a key / mount).
function DescriptionEditor({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
}) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group -mx-1 inline-flex items-start gap-1.5 self-start rounded px-1 text-left text-xs leading-relaxed transition-colors hover:bg-accent/50"
      >
        {value ? (
          <span className="text-muted-foreground">{value}</span>
        ) : (
          <span className="italic text-muted-foreground/50">{t(($) => $.inspector.no_description_placeholder)}</span>
        )}
        <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          {open && (
            <DescriptionEditorBody
              initialValue={value}
              onSave={onSave}
              onClose={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DescriptionEditorBody({
  initialValue,
  onSave,
  onClose,
}: {
  initialValue: string;
  onSave: (next: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT("agents");
  const [draft, setDraft] = useState(initialValue);
  const [saving, setSaving] = useState(false);

  const length = [...draft].length;
  const overLimit = length > AGENT_DESCRIPTION_MAX_LENGTH;
  const dirty = draft !== initialValue;

  const commit = async () => {
    if (overLimit || !dirty) return;
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch {
      // toast handled by parent's onUpdate
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(($) => $.inspector.edit_description_title)}</DialogTitle>
        <DialogDescription>
          {t(($) => $.inspector.edit_description_description)}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t(($) => $.inspector.description_placeholder)}
          rows={6}
          aria-invalid={overLimit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onClose();
              return;
            }
            if (isImeComposing(e)) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
          className="resize-none text-sm"
        />
        <CharCounter length={length} max={AGENT_DESCRIPTION_MAX_LENGTH} />
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          disabled={saving}
        >
          {t(($) => $.inspector.cancel)}
        </Button>
        <Button
          size="sm"
          onClick={() => void commit()}
          disabled={saving || overLimit || !dirty}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t(($) => $.inspector.save)}
        </Button>
      </DialogFooter>
    </>
  );
}


// Generic single-field popover editor used for name / description. Keeps the
// trigger styling fully in the caller's hands by using a render prop.
function InlineEditPopover({
  value,
  onSave,
  kind,
  title,
  placeholder,
  validate,
  children,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  kind: "input" | "textarea";
  title: string;
  placeholder?: string;
  validate?: (v: string) => string | null;
  children: (triggerProps: {
    onClick: (e: React.MouseEvent) => void;
  }) => ReactNode;
}) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset draft when popover opens or upstream value changes between sessions.
  useEffect(() => {
    if (open) {
      setDraft(value);
      setError(null);
    }
  }, [open, value]);

  const commit = async () => {
    const err = validate?.(draft) ?? null;
    if (err) {
      setError(err);
      return;
    }
    if (draft === value) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setOpen(false);
    } catch {
      // toast handled by parent's onUpdate
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={children({ onClick: () => setOpen(true) }) as React.ReactElement}
      />
      <PopoverContent align="start" className="w-72 p-3">
        <div className="space-y-2">
          <p className="text-xs font-medium">{title}</p>
          {kind === "input" ? (
            <Input
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  return;
                }
                if (isImeComposing(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                }
              }}
              className="h-8"
            />
          ) : (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  return;
                }
                if (isImeComposing(e)) return;
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void commit();
                }
              }}
              rows={3}
              className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-input"
            />
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              {t(($) => $.inspector.cancel)}
            </Button>
            <Button
              size="sm"
              onClick={() => void commit()}
              disabled={saving || draft === value}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t(($) => $.inspector.save)
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Presence badge — unchanged from the previous version
// ---------------------------------------------------------------------------

function PresenceBadge({
  presence,
}: {
  presence: AgentPresenceDetail | null | undefined;
}) {
  const { t } = useT("agents");
  // Archived is carried by the unified presence (deriveAgentPresenceDetail
  // sets availability="archived" before any runtime/task scan), so the
  // normal path below renders the gray "Archived" badge with no special
  // case here — same single source of truth as every other status surface.
  if (!presence) {
    return (
      <span className="inline-flex h-5 w-20 animate-pulse rounded-md bg-muted" />
    );
  }
  const av = availabilityConfig[presence.availability];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs ${av.textClass}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${av.dotClass}`} />
        {t(($) => $.availability[presence.availability])}
      </span>
    </div>
  );
}
