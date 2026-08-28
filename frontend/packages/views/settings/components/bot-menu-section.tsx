"use client";

import { useEffect, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, GripVertical, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { botMenuOptions, memberListOptions, workspaceKeys } from "@multiremi/core/workspace/queries";
import type {
  BotMenuAudience,
  BotMenuBehavior,
  BotMenuConfig,
  BotMenuItem,
  BotMenuPublishResponse,
  BotMenuTarget,
  MemberRole,
  MemberWithUser,
} from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";

type DraftItem = BotMenuItem & { _id: string; children?: DraftItem[] };
type DraftAudience = Omit<BotMenuAudience, "items"> & { _id: string; items: DraftItem[] };
type DraftConfig = { default: DraftItem[]; users: DraftAudience[] };

let localId = 0;
function nextId(prefix: string): string {
  localId += 1;
  return `${prefix}-${localId}`;
}

export function BotMenuSection() {
  const { t } = useT("settings");
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const menuQuery = useQuery(botMenuOptions(workspaceId));
  const membersQuery = useQuery(memberListOptions(workspaceId));
  const members = membersQuery.data ?? [];
  const currentRole = members.find((member) => member.user_id === user?.id)?.role;
  const canManage = currentRole === "owner" || currentRole === "admin";
  const [draft, setDraft] = useState<DraftConfig>(() => fromConfig({}));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState<"dry" | "live" | null>(null);
  const [publishRequest, setPublishRequest] = useState<BotMenuPublishResponse | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  useEffect(() => {
    if (!menuQuery.data || dirty) return;
    setDraft(fromConfig(menuQuery.data.bot_menu));
  }, [menuQuery.data, dirty]);

  useEffect(() => {
    if (!publishRequest || !["pending", "running"].includes(publishRequest.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        setPublishRequest(await api.getBotMenuPublish(workspaceId, publishRequest.id));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t(($) => $.feishu.botMenu.publish_failed));
        setPublishing(null);
      }
    }, 750);
    return () => window.clearTimeout(timer);
  }, [publishRequest, t, workspaceId]);

  useEffect(() => {
    if (!publishRequest || ["pending", "running"].includes(publishRequest.status)) return;
    setPublishing(null);
    if (publishRequest.status === "completed") {
      toast.success(publishRequest.dry_run
        ? t(($) => $.feishu.botMenu.validation_succeeded)
        : t(($) => $.feishu.botMenu.publish_succeeded));
    } else {
      toast.error(publishRequest.error || t(($) => $.feishu.botMenu.publish_failed));
    }
  }, [publishRequest, t]);

  const config = useMemo(() => toConfig(draft), [draft]);

  function change(next: DraftConfig) {
    setDraft(next);
    setDirty(true);
    setPublishRequest(null);
  }

  async function save(): Promise<boolean> {
    if (!canManage || saving) return false;
    setSaving(true);
    try {
      const response = await api.updateBotMenu(workspaceId, config);
      queryClient.setQueryData(workspaceKeys.botMenu(workspaceId), response);
      setDraft(fromConfig(response.bot_menu));
      setDirty(false);
      toast.success(t(($) => $.feishu.botMenu.saved));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.feishu.botMenu.save_failed));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function publish(dryRun: boolean) {
    if (!canManage || publishing) return;
    if (dirty && !(await save())) return;
    setPublishing(dryRun ? "dry" : "live");
    try {
      setPublishRequest(await api.publishBotMenu(workspaceId, dryRun));
    } catch (error) {
      setPublishing(null);
      toast.error(error instanceof Error ? error.message : t(($) => $.feishu.botMenu.publish_failed));
    }
  }

  if (menuQuery.isPending || membersQuery.isPending) {
    return <div className="h-28 animate-pulse rounded border bg-muted/30" />;
  }

  return (
    <section className="space-y-6 border-t pt-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t(($) => $.feishu.botMenu.title)}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t(($) => $.feishu.botMenu.description)}</p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={saving || Boolean(publishing)} onClick={() => void save()}>
              {saving ? t(($) => $.feishu.botMenu.saving) : t(($) => $.feishu.botMenu.save)}
            </Button>
            <Button variant="outline" size="sm" disabled={saving || Boolean(publishing)} onClick={() => void publish(true)}>
              <CheckCircle2 className="size-4" />
              {publishing === "dry" ? t(($) => $.feishu.botMenu.validating) : t(($) => $.feishu.botMenu.validate)}
            </Button>
            <Button size="sm" disabled={saving || Boolean(publishing)} onClick={() => setConfirmLive(true)}>
              <Send className="size-4" />
              {publishing === "live" ? t(($) => $.feishu.botMenu.publishing) : t(($) => $.feishu.botMenu.publish)}
            </Button>
          </div>
        )}
      </header>

      {!canManage && (
        <p className="rounded border px-3 py-2 text-sm text-muted-foreground">
          {t(($) => $.feishu.botMenu.read_only)}
        </p>
      )}

      <MenuEditor
        title={t(($) => $.feishu.botMenu.default_title)}
        items={draft.default}
        disabled={!canManage}
        onChange={(items) => change({ ...draft, default: items })}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">{t(($) => $.feishu.botMenu.audiences_title)}</h3>
            <p className="text-xs text-muted-foreground">{t(($) => $.feishu.botMenu.audiences_description)}</p>
          </div>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => change({
                ...draft,
                users: [...draft.users, newAudience(members)],
              })}
            >
              <Plus className="size-4" />
              {t(($) => $.feishu.botMenu.add_audience)}
            </Button>
          )}
        </div>

        {draft.users.length === 0 ? (
          <p className="border-y py-6 text-center text-sm text-muted-foreground">
            {t(($) => $.feishu.botMenu.no_audiences)}
          </p>
        ) : draft.users.map((audience, index) => (
          <AudienceEditor
            key={audience._id}
            audience={audience}
            members={members}
            disabled={!canManage}
            onChange={(next) => change({
              ...draft,
              users: draft.users.map((entry, candidate) => candidate === index ? next : entry),
            })}
            onDelete={() => change({ ...draft, users: draft.users.filter((_, candidate) => candidate !== index) })}
          />
        ))}
      </div>

      {publishRequest && (
        <div className={cn(
          "rounded border px-3 py-2 text-sm",
          publishRequest.status === "completed" ? "border-emerald-500/40 bg-emerald-500/5" :
            publishRequest.status === "failed" || publishRequest.status === "timeout" ? "border-destructive/40 bg-destructive/5" : "bg-muted/30",
        )}>
          {publishStatusText(publishRequest, t)}
        </div>
      )}

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.feishu.botMenu.confirm_title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.feishu.botMenu.confirm_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.feishu.botMenu.cancel)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void publish(false)}>{t(($) => $.feishu.botMenu.confirm_publish)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function AudienceEditor({ audience, members, disabled, onChange, onDelete }: {
  audience: DraftAudience;
  members: MemberWithUser[];
  disabled: boolean;
  onChange: (audience: DraftAudience) => void;
  onDelete: () => void;
}) {
  const { t } = useT("settings");
  return (
    <div className="space-y-4 rounded border p-4">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t(($) => $.feishu.botMenu.target_type)}</Label>
            <Select
              disabled={disabled}
              value={audience.target.type}
              onValueChange={(value) => value && onChange({ ...audience, target: newTarget(value, members) })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t(($) => $.feishu.botMenu.target_member)}</SelectItem>
                <SelectItem value="role">{t(($) => $.feishu.botMenu.target_role)}</SelectItem>
                <SelectItem value="external">{t(($) => $.feishu.botMenu.target_external)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <TargetEditor
            target={audience.target}
            members={members}
            disabled={disabled}
            onChange={(target) => onChange({ ...audience, target })}
          />
        </div>
        {!disabled && (
          <Button variant="ghost" size="icon" title={t(($) => $.feishu.botMenu.delete_audience)} onClick={onDelete}>
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <MenuEditor
        title={audience.label || targetLabel(audience.target, members)}
        items={audience.items}
        disabled={disabled}
        onChange={(items) => onChange({ ...audience, items })}
      />
    </div>
  );
}

function TargetEditor({ target, members, disabled, onChange }: {
  target: BotMenuTarget;
  members: MemberWithUser[];
  disabled: boolean;
  onChange: (target: BotMenuTarget) => void;
}) {
  const { t } = useT("settings");
  if (target.type === "member") {
    return (
      <div className="space-y-1.5">
        <Label>{t(($) => $.feishu.botMenu.member)}</Label>
        <Select disabled={disabled} value={target.memberId} onValueChange={(memberId) => memberId && onChange({ type: "member", memberId })}>
          <SelectTrigger><SelectValue placeholder={t(($) => $.feishu.botMenu.select_member)} /></SelectTrigger>
          <SelectContent>
            {members.map((member) => <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    );
  }
  if (target.type === "role") {
    return (
      <div className="space-y-1.5">
        <Label>{t(($) => $.feishu.botMenu.role)}</Label>
        <Select disabled={disabled} value={target.role} onValueChange={(role) => role && onChange({ type: "role", role: role as MemberRole })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="owner">Owner</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="member">Member</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
      <Select disabled={disabled} value={target.userIdType} onValueChange={(userIdType) => userIdType && onChange({ ...target, userIdType: userIdType as typeof target.userIdType })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="open_id">open_id</SelectItem>
          <SelectItem value="union_id">union_id</SelectItem>
          <SelectItem value="user_id">user_id</SelectItem>
        </SelectContent>
      </Select>
      <Input disabled={disabled} value={target.userId} placeholder={t(($) => $.feishu.botMenu.external_id)} onChange={(event) => onChange({ ...target, userId: event.target.value })} />
    </div>
  );
}

function MenuEditor({ title, items, disabled, onChange, depth = 0 }: {
  title: string;
  items: DraftItem[];
  disabled: boolean;
  onChange: (items: DraftItem[]) => void;
  depth?: 0 | 1;
}) {
  const { t } = useT("settings");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function dragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = items.findIndex((item) => item._id === event.active.id);
    const to = items.findIndex((item) => item._id === event.over!.id);
    if (from >= 0 && to >= 0) onChange(arrayMove(items, from, to));
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h4>
        {!disabled && (
          <Button variant="ghost" size="sm" onClick={() => onChange([...items, newItem()])}>
            <Plus className="size-4" />
            {t(($) => $.feishu.botMenu.add_item)}
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="rounded border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">{t(($) => $.feishu.botMenu.no_items)}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <SortableContext items={items.map((item) => item._id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {items.map((item, index) => (
                <SortableMenuItem
                  key={item._id}
                  item={item}
                  disabled={disabled}
                  depth={depth}
                  onChange={(next) => onChange(items.map((entry, candidate) => candidate === index ? next : entry))}
                  onDelete={() => onChange(items.filter((_, candidate) => candidate !== index))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function SortableMenuItem({ item, disabled, depth, onChange, onDelete }: {
  item: DraftItem;
  disabled: boolean;
  depth: 0 | 1;
  onChange: (item: DraftItem) => void;
  onDelete: () => void;
}) {
  const { t } = useT("settings");
  const [expanded, setExpanded] = useState(false);
  const sortable = useSortable({ id: item._id, disabled });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const behavior = item.behaviors?.[0] ?? { type: "send_message" as const };
  const hasChildren = Boolean(item.children);
  return (
    <div ref={sortable.setNodeRef} style={style} className={cn("rounded border bg-background", sortable.isDragging && "opacity-60 shadow-sm")}>
      <div className="flex min-h-12 items-center gap-1 p-2">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </Button>
        <button
          type="button"
          className="flex size-8 shrink-0 cursor-grab items-center justify-center text-muted-foreground disabled:cursor-default"
          disabled={disabled}
          aria-label={t(($) => $.feishu.botMenu.drag_item)}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <Input
          className="min-w-0 flex-1"
          disabled={disabled}
          value={item.name}
          placeholder={t(($) => $.feishu.botMenu.item_name)}
          onChange={(event) => onChange({ ...item, name: event.target.value })}
        />
        {!disabled && (
          <Button variant="ghost" size="icon" title={t(($) => $.feishu.botMenu.delete_item)} onClick={onDelete}>
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="space-y-3 border-t p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t(($) => $.feishu.botMenu.item_tag)}</Label>
              <Input disabled={disabled} value={item.tag ?? ""} onChange={(event) => onChange({ ...item, tag: event.target.value || undefined })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t(($) => $.feishu.botMenu.item_kind)}</Label>
              <Select
                disabled={disabled}
                value={hasChildren ? "submenu" : behavior.type}
                onValueChange={(value) => {
                  if (!value) return;
                  if (value === "submenu") onChange({ ...item, behaviors: undefined, children: item.children ?? [] });
                  else onChange({ ...item, children: undefined, behaviors: [{ type: value as BotMenuBehavior["type"] }] });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="send_message">{t(($) => $.feishu.botMenu.kind_message)}</SelectItem>
                  <SelectItem value="target">{t(($) => $.feishu.botMenu.kind_link)}</SelectItem>
                  <SelectItem value="event_key">{t(($) => $.feishu.botMenu.kind_event)}</SelectItem>
                  {depth === 0 && <SelectItem value="submenu">{t(($) => $.feishu.botMenu.kind_submenu)}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!hasChildren && behavior.type === "target" && (
            <Input disabled={disabled} value={behavior.url ?? ""} placeholder="https://" onChange={(event) => onChange({ ...item, behaviors: [{ ...behavior, url: event.target.value }] })} />
          )}
          {!hasChildren && behavior.type === "event_key" && (
            <Input disabled={disabled} value={behavior.eventKey ?? ""} placeholder="event_key" onChange={(event) => onChange({ ...item, behaviors: [{ ...behavior, eventKey: event.target.value }] })} />
          )}
          {hasChildren && (
            <MenuEditor
              title={t(($) => $.feishu.botMenu.children)}
              items={item.children ?? []}
              disabled={disabled}
              depth={1}
              onChange={(children) => onChange({ ...item, children })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function newItem(): DraftItem {
  return { _id: nextId("menu"), name: "", behaviors: [{ type: "send_message" }] };
}

function newAudience(members: MemberWithUser[]): DraftAudience {
  return {
    _id: nextId("audience"),
    target: members[0] ? { type: "member", memberId: members[0].id } : { type: "role", role: "member" },
    items: [],
  };
}

function newTarget(type: string, members: MemberWithUser[]): BotMenuTarget {
  if (type === "role") return { type: "role", role: "member" };
  if (type === "external") return { type: "external", userId: "", userIdType: "open_id" };
  return members[0] ? { type: "member", memberId: members[0].id } : { type: "role", role: "member" };
}

function fromConfig(config: BotMenuConfig): DraftConfig {
  const inflate = (items: BotMenuItem[] = []): DraftItem[] => items.map(({ children, ...item }) => ({
    ...item,
    _id: nextId("menu"),
    ...(children ? { children: inflate(children) } : {}),
  }));
  return {
    default: inflate(config.default),
    users: (config.users ?? []).map((audience) => ({ ...audience, _id: nextId("audience"), items: inflate(audience.items) })),
  };
}

function toConfig(draft: DraftConfig): BotMenuConfig {
  const strip = (items: DraftItem[]): BotMenuItem[] => items.map(({ _id: _unused, children, ...item }) => ({
    ...item,
    ...(children ? { children: strip(children) } : {}),
  }));
  return {
    default: strip(draft.default),
    users: draft.users.map(({ _id: _unused, items, ...audience }) => ({ ...audience, items: strip(items) })),
  };
}

function targetLabel(target: BotMenuTarget, members: MemberWithUser[]): string {
  if (target.type === "member") return members.find((member) => member.id === target.memberId)?.name ?? target.memberId;
  if (target.type === "role") return target.role;
  return `${target.userIdType}: ${target.userId}`;
}

function publishStatusText(
  request: BotMenuPublishResponse,
  t: ReturnType<typeof useT<"settings">>["t"],
): string {
  if (request.status === "pending" || request.status === "running") return t(($) => $.feishu.botMenu.publish_waiting);
  if (request.status !== "completed") return request.error || t(($) => $.feishu.botMenu.publish_failed);
  const count = request.result?.userMenuCount ?? 0;
  return request.dry_run
    ? t(($) => $.feishu.botMenu.validation_summary, { count })
    : t(($) => $.feishu.botMenu.publish_summary, { count });
}
