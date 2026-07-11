"use client";

import { useState } from "react";
import { Globe, Lock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { ModelDropdown } from "./model-dropdown";
import { InstructionsEditor } from "./instructions-editor";
import { SkillMultiSelect } from "./skill-multi-select";
import { AvatarPicker } from "./avatar-picker";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useFleetProviderModels } from "@multiremi/core/runtimes";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import type {
  Agent,
  AgentVisibility,
  CreateAgentRequest,
} from "@multiremi/core/types";
import { isImeComposing } from "@multiremi/core/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@multiremi/ui/components/ui/dialog";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { toast } from "sonner";
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  VISIBILITY_DESCRIPTION,
  VISIBILITY_LABEL,
} from "@multiremi/core/agents";
import { CharCounter } from "./char-counter";
import { useT } from "../../i18n";

// The two engines a pool agent can run on. Static by design: these are the
// providers the daemon fleet ships bridges for; the fleet catalog only
// refines each engine's models + capacity.
const ENGINES = ["claude", "codex"] as const;

export function CreateAgentDialog({
  template,
  squadId,
  onClose,
  onCreate,
}: {
  // When provided, the dialog opens in "Duplicate" mode: the visible
  // fields (name / description / engine / visibility / model) are
  // pre-populated from this agent, and the hidden fields
  // (instructions / custom_args / custom_env / max_concurrent_tasks)
  // are forwarded to the create call so the new agent is a true clone.
  // Skills are copied separately by the caller after createAgent
  // succeeds — they're not part of CreateAgentRequest.
  template?: Agent | null;
  // When set, every successful create is followed by
  // addSquadMember(squadId, agent) so the new agent joins this squad.
  // If the squad-join call fails the agent still exists and the dialog
  // surfaces a warning toast — the user can add it manually from the
  // Members tab.
  squadId?: string;
  onClose: () => void;
  // Returns the created Agent so the dialog can run a follow-up
  // setAgentSkills with the IDs the user picked in the form. Pre-skill-
  // section callers can keep returning `void`; the dialog tolerates a
  // falsy return (no follow-up runs).
  onCreate: (data: CreateAgentRequest) => Promise<Agent | void>;
}) {
  const { t } = useT("agents");
  const isDuplicate = !!template;
  const queryClient = useQueryClient();
  const wsId = useWorkspaceId();

  // Name defaults: duplicate uses "<original> copy". Manual-create starts blank.
  const [name, setName] = useState(
    template ? `${template.name}${t(($) => $.create_dialog.duplicate_copy_suffix)}` : "",
  );
  const [description, setDescription] = useState(template?.description ?? "");
  const [visibility, setVisibility] = useState<AgentVisibility>(
    template?.visibility ?? "workspace",
  );
  const [model, setModel] = useState(template?.model ?? "");
  const [instructions, setInstructions] = useState(template?.instructions ?? "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(template?.avatar_url ?? null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    () => new Set(template?.skills.map((s) => s.id) ?? []),
  );
  const [creating, setCreating] = useState(false);

  // Engine (provider). There is no machine to pick — the pool schedules
  // work onto any online runtime of this provider. Duplicate mode inherits
  // the source agent's engine; old backends may omit it, so fall back to
  // the default engine.
  const [provider, setProvider] = useState<string>(
    template?.provider && (ENGINES as readonly string[]).includes(template.provider)
      ? template.provider
      : "claude",
  );
  // Capacity signal for the selected engine — 0 online machines means new
  // tasks would queue until one comes up. Purely informational; creation
  // stays allowed.
  const fleet = useFleetProviderModels(wsId ?? "", provider);

  const switchEngine = (next: string) => {
    if (next === provider) return;
    setProvider(next);
    // The model catalog is per-engine; a claude model id makes no sense on
    // codex. Reset to "engine default" on switch.
    setModel("");
  };

  // Shared squad-join follow-up. Returns nothing — the caller has
  // already shown its create-success toast; we only need to surface a
  // warning when the agent landed but the squad-join failed. Cache
  // invalidation for the squad's members list rides along so the
  // Members tab re-renders without a manual refetch.
  const attachToSquad = async (agentId: string, displayName: string) => {
    if (!squadId) return;
    try {
      await api.addSquadMember(squadId, {
        member_type: "agent",
        member_id: agentId,
      });
      if (wsId) {
        queryClient.invalidateQueries({
          queryKey: [...workspaceKeys.squads(wsId), squadId, "members"],
        });
        queryClient.invalidateQueries({
          queryKey: [...workspaceKeys.squads(wsId), squadId],
        });
      }
    } catch (err) {
      toast.warning(
        t(($) => $.create_dialog.squad_join_failed_toast, {
          name: displayName,
          error: err instanceof Error ? err.message : "unknown error",
        }),
      );
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setCreating(true);

    try {
      const trimmedInstructions = instructions.trim();
      const data: CreateAgentRequest = {
        name: name.trim(),
        description: description.trim(),
        provider,
        visibility,
        model: model.trim() || undefined,
        instructions: trimmedInstructions || undefined,
        avatar_url: avatarUrl ?? undefined,
      };
      if (template) {
        // Duplicate path: forward the hidden config fields the source
        // agent had so the clone is functional out of the box (args /
        // concurrency). Skills flow through the dialog form. As of
        // MUL-2600 the agent resource shape no longer carries
        // custom_env values, so duplication cannot copy env at all —
        // the user has to re-set env on the clone via the env tab
        // (which now goes through the audited `/env` endpoint). The
        // dialog's create call still accepts custom_env at create
        // time, but the source values aren't available here.
        if (template.custom_args.length) data.custom_args = template.custom_args;
        if (template.max_concurrent_tasks) {
          data.max_concurrent_tasks = template.max_concurrent_tasks;
        }
      }
      const createdAgent = await onCreate(data);
      // Follow-up: attach selected skills to the newly created agent.
      // onCreate returns the created Agent for this path; if the caller
      // doesn't return it we fall back to skipping (preserves
      // backward compatibility with non-skill-aware callers).
      if (createdAgent && selectedSkillIds.size > 0) {
        try {
          await api.setAgentSkills(createdAgent.id, {
            skill_ids: [...selectedSkillIds],
          });
          if (wsId) {
            queryClient.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
          }
        } catch (skillErr) {
          // Non-fatal: agent exists, skills can be added on the detail
          // page. Surface as a warning toast so the user knows.
          toast.warning(
            t(($) => $.create_dialog.skill_attach_failed_toast, {
              error:
                skillErr instanceof Error ? skillErr.message : "unknown error",
            }),
          );
        }
      }
      // Squad context: attach the agent after skills land so the
      // squad's Members tab shows the agent with its skills already
      // in place. Atomicity is best-effort by design (see plan in
      // MUL-2178) — a partial failure surfaces a warning toast and
      // the user can retry from the Add Member dialog.
      if (createdAgent && squadId) {
        await attachToSquad(createdAgent.id, createdAgent.name);
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.create_dialog.create_failed_toast));
      setCreating(false);
    }
  };

  const headerTitle = isDuplicate
    ? t(($) => $.create_dialog.title_duplicate)
    : t(($) => $.create_dialog.title_create);

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="p-0 gap-0 flex flex-col overflow-hidden !top-1/2 !left-1/2 !-translate-x-1/2 !-translate-y-1/2 !w-full !max-w-2xl !h-[85vh]">
        <DialogHeader className="border-b px-5 py-3 space-y-0">
          <DialogTitle className="text-base font-semibold">{headerTitle}</DialogTitle>
          {isDuplicate && template && (
            <DialogDescription className="mt-1 text-xs">
              {t(($) => $.create_dialog.description_duplicate, { name: template.name })}
            </DialogDescription>
          )}
          {!isDuplicate && (
            <DialogDescription className="mt-1 text-xs">
              {t(($) => $.create_dialog.description_create)}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-4 min-w-0">
            {/* Identity row: avatar (left) + name & description stack
                (right). The avatar visually anchors the identity of
                what the user is creating; pairing it with the Name
                field reads as "this is the agent's face + name",
                same shape as detail-page header so the affordance is
                instantly familiar. */}
            <div className="flex items-start gap-4">
              <AvatarPicker value={avatarUrl} onChange={setAvatarUrl} size={64} />
              <div className="flex-1 min-w-0 space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.create_dialog.name_label)}</Label>
                  <Input
                    autoFocus
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t(($) => $.create_dialog.name_placeholder)}
                    className="mt-1"
                    onKeyDown={(e) => {
                      if (isImeComposing(e)) return;
                      if (e.key === "Enter") handleSubmit();
                    }}
                  />
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">{t(($) => $.create_dialog.description_label)}</Label>
                  <Input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t(($) => $.create_dialog.description_placeholder)}
                    maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
                    className="mt-1"
                  />
                  <div className="mt-1">
                    <CharCounter
                      length={[...description].length}
                      max={AGENT_DESCRIPTION_MAX_LENGTH}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">{t(($) => $.create_dialog.visibility_label)}</Label>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => setVisibility("workspace")}
                  className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    visibility === "workspace"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="text-left">
                    <div className="font-medium">{VISIBILITY_LABEL.workspace}</div>
                    <div className="text-xs text-muted-foreground">
                      {VISIBILITY_DESCRIPTION.workspace}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setVisibility("private")}
                  className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    visibility === "private"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="text-left">
                    <div className="font-medium">{VISIBILITY_LABEL.private}</div>
                    <div className="text-xs text-muted-foreground">
                      {VISIBILITY_DESCRIPTION.private}
                    </div>
                  </div>
                </button>
              </div>
            </div>

            {/* Engine: the only "where does it run"-adjacent choice left.
                Machines are gone from this flow — the pool schedules work
                onto any online runtime of the chosen engine. */}
            <div>
              <Label className="text-xs text-muted-foreground">{t(($) => $.create_dialog.engine_label)}</Label>
              <div className="mt-1.5 flex gap-2">
                {ENGINES.map((engine) => (
                  <button
                    type="button"
                    key={engine}
                    onClick={() => switchEngine(engine)}
                    className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                      provider === engine
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    <ProviderLogo provider={engine} className="h-4 w-4 shrink-0" />
                    <span className="font-medium capitalize">{engine}</span>
                  </button>
                ))}
              </div>
              {!fleet.isLoading && fleet.onlineRuntimeCount === 0 && (
                <p className="mt-1.5 text-xs text-warning">
                  {t(($) => $.create_dialog.engine_no_capacity)}
                </p>
              )}
            </div>

            <ModelDropdown
              wsId={wsId ?? ""}
              provider={provider}
              value={model}
              onChange={setModel}
            />

            {/* --- Optional sections (instructions / skills) ---
                Collapsed by default so quick-create stays fast.
                Duplicate pre-fills everything from the source agent. */}
            <InstructionsEditor
              value={instructions}
              onChange={setInstructions}
              placeholder={
                isDuplicate
                  ? t(($) => $.create_dialog.instructions.placeholder_duplicate)
                  : t(($) => $.create_dialog.instructions.placeholder_blank)
              }
            />

            <SkillMultiSelect
              selectedIds={selectedSkillIds}
              onChange={setSelectedSkillIds}
            />
          </div>
        </div>

        {/* Inline footer instead of <DialogFooter>: the shipped
            DialogFooter applies `-mx-4 -mb-4` assuming a padded
            DialogContent (default `p-4`). Our DialogContent uses
            `p-0`, so those negative margins push the footer outside
            the dialog. A plain flex row anchored by `border-t` keeps
            the visual rhythm without the overflow bug. */}
        <div className="flex items-center justify-end gap-2 border-t bg-background px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            {t(($) => $.create_dialog.cancel)}
          </Button>
          <Button onClick={handleSubmit} disabled={creating || !name.trim()}>
            {creating ? t(($) => $.create_dialog.creating) : t(($) => $.create_dialog.create)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
