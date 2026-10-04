"use client";

import { createContext, use, useMemo, type ReactNode } from "react";
import type { Attachment } from "@multiremi/core/types";
import { isAllowedFileCardHref } from "@multiremi/ui/markdown";
import { openExternal } from "../platform";
import { useDownloadAttachment } from "./use-download-attachment";

interface ResolvedDownload {
  // Returns the attachment id for a URL referenced in the markdown, or
  // `undefined` if it's an external link we don't manage.
  resolveAttachmentId: (url: string) => string | undefined;
  // Returns the full Attachment record (content_type, filename, download_url,
  // ...) for a URL referenced in the markdown. NodeView preview triggers use
  // this to decide whether the type is previewable and to feed the modal.
  resolveAttachment: (url: string) => Attachment | undefined;
  // Called by NodeView click handlers. Re-signs through `getAttachment` when
  // the URL maps to a known attachment; falls back to `openExternal` for
  // external URLs so Electron still routes through the IPC bridge instead of
  // letting `window.open` hit the `setWindowOpenHandler` deny path.
  openByUrl: (url: string) => void;
}

const AttachmentDownloadContext = createContext<ResolvedDownload | null>(null);

/**
 * Exact URL first. An optional query must not lose the record's ID-based
 * download/preview, so only strict authenticated attachment paths may fall
 * back to matching by the ID in the path.
 */
function findAttachmentByUrl(attachments: Attachment[] | undefined, url: string): Attachment | undefined {
  if (!url || !attachments?.length) return undefined;
  const exact = attachments.find(a => a.url === url);
  if (exact) return exact;
  const id = isAllowedFileCardHref(url)
    ? /^\/api\/attachments\/([A-Za-z0-9_-]+)\/content(?:\?|$)/.exec(url)?.[1]
    : undefined;
  return id ? attachments.find(a => a.id === id) : undefined;
}

interface ProviderProps {
  attachments?: Attachment[];
  loadAttachments?: () => Promise<Attachment[]>;
  children: ReactNode;
}

/**
 * Provides a click-time download handler to Tiptap NodeViews mounted inside
 * `ContentEditor`. Without a provider the consumer falls back to opening the
 * raw URL via `openExternal` — same behaviour as before this hook existed.
 */
export function AttachmentDownloadProvider({ attachments, loadAttachments, children }: ProviderProps) {
  const download = useDownloadAttachment();
  const value = useMemo<ResolvedDownload>(
    () => {
      const resolveAttachment = (url: string): Attachment | undefined =>
        findAttachmentByUrl(attachments, url);
      return {
        resolveAttachmentId: (url) => resolveAttachment(url)?.id,
        resolveAttachment,
        openByUrl: async (url) => {
          if (!url) return;
          let att = resolveAttachment(url);
          if (!att && loadAttachments) {
            try {
              att = findAttachmentByUrl(await loadAttachments(), url);
            } catch {
              // Unmanaged links remain usable if metadata cannot be loaded.
            }
          }
          if (att) {
            void download(att.id);
            return;
          }
          openExternal(url);
        },
      };
    },
    [attachments, loadAttachments, download],
  );
  return (
    <AttachmentDownloadContext.Provider value={value}>
      {children}
    </AttachmentDownloadContext.Provider>
  );
}

/**
 * Returns the click-time download handler installed by a surrounding
 * `AttachmentDownloadProvider`, or a fallback that just opens the raw URL
 * externally. Used by file-card and image NodeViews so they can stay
 * usable in editor surfaces that haven't been wired up yet.
 */
export function useAttachmentDownloadResolver(): ResolvedDownload {
  const ctx = use(AttachmentDownloadContext);
  // Hooks-must-be-unconditional: always create the fallback object, but
  // memoization is unnecessary here because each NodeView render also
  // re-runs the click handler closure.
  if (ctx) return ctx;
  return {
    resolveAttachmentId: () => undefined,
    resolveAttachment: () => undefined,
    openByUrl: (url) => {
      if (url) openExternal(url);
    },
  };
}
