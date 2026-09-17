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
  loadError = false,
  onSelect,
}: {
  projects: Project[];
  projectId: string | null;
  disabled?: boolean;
  loadError?: boolean;
  onSelect: (projectId: string | null) => void;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const current = projects.find((project) => project.id === projectId && !project.archived_at);
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
      tooltip={t(($) => $.project.description)}
      header={
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t(($) => $.project.fixed_hint)}
        </p>
      }
      triggerRender={
        <button
          type="button"
          disabled={disabled}
          aria-label={`${t(($) => $.project.label)}: ${label}`}
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

/** Existing sessions keep the project selected at creation. */
export function ProjectDisplay({
  projects,
  projectId,
}: {
  projects: Project[];
  projectId: string | null;
}) {
  const { t } = useT("chat");
  const current = projects.find((project) => project.id === projectId && !project.archived_at);
  const label = current?.title ?? (projectId ? t(($) => $.project.unavailable) : t(($) => $.project.none));

  return (
    <div
      role="group"
      aria-label={`${t(($) => $.project.label)}: ${label}`}
      title={t(($) => $.project.fixed_hint)}
      className="flex min-w-0 max-w-full items-center gap-1.5 px-1.5 py-1 -ml-1"
    >
      {current ? <ProjectIcon project={current} size="sm" /> : <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate text-xs font-medium">{label}</span>
    </div>
  );
}
