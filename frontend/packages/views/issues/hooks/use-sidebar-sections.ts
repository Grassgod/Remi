"use client";

import { useCallback, useState } from "react";

export type SidebarSectionKey =
  | "properties"
  | "subIssues"
  | "parentIssue"
  | "codeChanges"
  | "details"
  | "tokenUsage"
  | "metadata";

const DEFAULT_OPEN: Record<SidebarSectionKey, boolean> = {
  properties: true,
  subIssues: true,
  parentIssue: true,
  codeChanges: true,
  details: true,
  tokenUsage: true,
  // Metadata is a dialog, not an inline fold — closed until asked for.
  metadata: false,
};

export interface SidebarSectionsState {
  isOpen: (key: SidebarSectionKey) => boolean;
  toggle: (key: SidebarSectionKey) => void;
  setOpen: (key: SidebarSectionKey, open: boolean) => void;
}

/**
 * Fold state for the issue sidebar sections. Owned by `IssueDetail` rather
 * than by the sidebar component so it survives the mobile sheet closing and
 * reopening.
 */
export function useSidebarSections(): SidebarSectionsState {
  const [open, setOpenState] = useState<Record<SidebarSectionKey, boolean>>(DEFAULT_OPEN);

  const isOpen = useCallback((key: SidebarSectionKey) => open[key], [open]);

  const setOpen = useCallback((key: SidebarSectionKey, next: boolean) => {
    setOpenState((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
  }, []);

  const toggle = useCallback((key: SidebarSectionKey) => {
    setOpenState((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return { isOpen, toggle, setOpen };
}
