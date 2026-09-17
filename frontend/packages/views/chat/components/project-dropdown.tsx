"use client";

import { useState } from "react";
import { ChevronDown, FolderKanban, MessageCircle } from "lucide-react";
import type { Project } from "@multiremi/core/types";
import {
  PickerEmpty,
  PickerItem,
  PropertyPicker,
} from "../../issues/components/pickers/property-picker";
import { ProjectIcon } from "../../projects/components/project-icon";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";

export function ProjectDropdown({
  projects,
  projectId,
  disabled = false,
  busy = false,
  loadError = false,
  onSelect,
}: {
  projects: Project[];
  projectId: string | null;
  disabled?: boolean;
  busy?: boolean;
  loadError?: boolean;
  onSelect: (projectId: string | null) => void;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const current = projects.find((project) => project.id === projectId);
  const query = filter.trim().toLowerCase();
  const available = projects.filter((project) =>
    !project.archived_at && (!query || project.title.toLowerCase().includes(query) || matchesPinyin(project.title, query)),
  );
  const label = current?.title ?? (projectId ? t(($) => $.project.unavailable) : t(($) => $.project.none));
  const handlePick = (id: string | null) => {
    if (disabled) return;
    if (id !== projectId) onSelect(id);
    setOpen(false);
  };

  return (
    <PropertyPicker
      open={open && !disabled}
      onOpenChange={setOpen}
      width="w-72"
      align="start"
      searchable
      searchPlaceholder={t(($) => $.project.search)}
      onSearchChange={setFilter}
      tooltip={busy ? t(($) => $.project.busy) : t(($) => $.project.description)}
      header={
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t(($) => $.project.change_hint)}
        </p>
      }
      triggerRender={
        <button
          type="button"
          disabled={disabled}
          aria-label={`${t(($) => $.project.label)}: ${label}`}
          title={busy ? t(($) => $.project.busy) : undefined}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1 cursor-pointer outline-none transition-colors hover:bg-accent aria-expanded:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        />
      }
      trigger={
        <>
          {current ? <ProjectIcon project={current} size="sm" /> : <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate text-xs font-medium">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </>
      }
    >
      <PickerItem selected={!projectId} onClick={() => handlePick(null)}>
        <MessageCircle className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{t(($) => $.project.none)}</span>
      </PickerItem>
      {loadError ? (
        <p role="alert" className="px-2 py-3 text-xs text-destructive">{t(($) => $.project.load_failed)}</p>
      ) : available.length === 0 ? <PickerEmpty /> : available.map((project) => (
        <PickerItem key={project.id} selected={project.id === projectId} onClick={() => handlePick(project.id)}>
          <ProjectIcon project={project} size="sm" />
          <span className="truncate">{project.title}</span>
        </PickerItem>
      ))}
    </PropertyPicker>
  );
}
