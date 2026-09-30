"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { Attachment } from "@multiremi/core/types";
import { issueAttachmentsOptions, issueKeys } from "@multiremi/core/issues/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useFileUpload } from "@multiremi/core/hooks/use-file-upload";
import { FileUploadButton } from "@multiremi/ui/components/common/file-upload-button";
import { ReactionBar } from "@multiremi/ui/components/common/reaction-bar";
import { Button } from "@multiremi/ui/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multiremi/ui/components/ui/tooltip";
import { EntryHtml } from "../../common/session-log/entry-html";
import { ContentEditor, ReadonlyContent, type ContentEditorRef, useFileDropZone, FileDropOverlay } from "../../editor";
import { useIssueReactions } from "../hooks/use-issue-reactions";
import { useT } from "../../i18n";

export function IssueLogHead({ issueId, entry, currentUserId, onSaved }: {
  issueId: string; entry: SessionLogRow; currentUserId?: string; onSaved: () => Promise<void>;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { getActorName } = useActorName();
  const { reactions, toggleReaction } = useIssueReactions(issueId, currentUserId);
  const { uploadWithToast } = useFileUpload(api);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Attachment[]>([]);
  const editor = useRef<ContentEditorRef>(null);
  const { data: attachments = [] } = useQuery({ ...issueAttachmentsOptions(issueId), enabled: editing });
  const upload = useCallback(async (file: File) => {
    const attachment = await uploadWithToast(file);
    if (attachment) setPending(previous => [...previous, attachment]);
    return attachment;
  }, [uploadWithToast]);
  const { isDragOver, dropZoneProps } = useFileDropZone({ enabled: editing,
    onDrop: files => files.forEach(file => editor.current?.uploadFile(file)),
  });
  const save = async () => {
    const description = editor.current?.getMarkdown() ?? "";
    setSaving(true);
    try {
      await api.patchIssue(issueId, { description, attachment_ids: pending.filter(a => description.includes(a.url)).map(a => a.id) });
      await onSaved();
      void qc.invalidateQueries({ queryKey: issueKeys.detail(wsId, issueId) });
      void qc.invalidateQueries({ queryKey: issueKeys.attachments(issueId) });
      setEditing(false); setPending([]);
    } catch (error) { toast.error(error instanceof Error ? error.message : t($ => $.comment.update_failed)); }
    finally { setSaving(false); }
  };
  return <section data-issue-log-head>
    {editing ? <div {...dropZoneProps} className="relative">
      <ContentEditor ref={editor} defaultValue={entry.body_md} placeholder={t($ => $.detail.desc_placeholder)}
        onUploadFile={upload} currentIssueId={issueId} attachments={[...attachments, ...pending]} />
      <div className="mt-2 flex items-center justify-between">
        <FileUploadButton size="sm" onSelect={file => editor.current?.uploadFile(file)} />
        <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={saving} onClick={() => { setEditing(false); setPending([]); }}>{t($ => $.comment.cancel_edit)}</Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}>{t($ => $.comment.save_action)}</Button></div>
      </div>
      {isDragOver && <FileDropOverlay />}
    </div> : <div className="relative pr-8">
      <EntryHtml html={entry.body_html} markdown={entry.body_md} fallback={<ReadonlyContent content={entry.body_md} />} />
      <Tooltip><TooltipTrigger render={<Button size="icon-sm" variant="ghost" className="absolute top-0 right-0" aria-label={t($ => $.comment.edit_action)} onClick={() => setEditing(true)}><Pencil /></Button>} />
        <TooltipContent>{t($ => $.comment.edit_action)}</TooltipContent></Tooltip>
    </div>}
    <div className="mt-3 flex h-8 items-center overflow-x-auto" data-issue-reaction-slot>
      <ReactionBar reactions={reactions} currentUserId={currentUserId} onToggle={toggleReaction} getActorName={getActorName} className="flex-nowrap" />
    </div>
  </section>;
}
