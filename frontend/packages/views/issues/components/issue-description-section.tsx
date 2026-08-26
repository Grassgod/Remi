"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { FileUploadButton } from "@multiremi/ui/components/common/file-upload-button";
import { ReactionBar } from "@multiremi/ui/components/common/reaction-bar";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import type { Attachment, Issue, UpdateIssueRequest } from "@multiremi/core/types";
import { api } from "@multiremi/core/api";
import { useFileUpload } from "@multiremi/core/hooks/use-file-upload";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import {
  childIssuesOptions,
  issueAttachmentsOptions,
  issueKeys,
} from "@multiremi/core/issues/queries";
import { AppLink } from "../../navigation";
import {
  ContentEditor,
  type ContentEditorRef,
  TitleEditor,
  useFileDropZone,
  FileDropOverlay,
} from "../../editor";
import { useT } from "../../i18n";
import { useIssueReactions } from "../hooks/use-issue-reactions";
import { StatusIcon } from ".";
import { ProgressRing } from "./progress-ring";

/** "Sub-issue of TES-1 …" line with the parent's own completion progress. */
function ParentIssueLink({ parentIssue }: { parentIssue: Issue }) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  // Parent's children — used to render the "x/y" progress next to the
  // "Sub-issue of …" breadcrumb under the title.
  const { data: siblings = [] } = useQuery(childIssuesOptions(wsId, parentIssue.id));
  const done = siblings.filter((c) => c.status === "done").length;

  return (
    <AppLink
      href={paths.issueDetail(parentIssue.id)}
      className="mt-2 inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group/parent"
    >
      <span className="font-medium shrink-0">{t(($) => $.detail.sub_issue_of)}</span>
      <StatusIcon status={parentIssue.status} className="h-3.5 w-3.5 shrink-0" />
      <span className="tabular-nums shrink-0">{parentIssue.identifier}</span>
      <span className="truncate group-hover/parent:text-foreground">
        {parentIssue.title}
      </span>
      {siblings.length > 0 && (
        <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 shrink-0">
          <ProgressRing done={done} total={siblings.length} size={11} />
          <span className="tabular-nums text-[10.5px] font-medium">
            {done}/{siblings.length}
          </span>
        </span>
      )}
    </AppLink>
  );
}

interface IssueDescriptionSectionProps {
  issue: Issue;
  issueId: string;
  parentIssue: Issue | null;
  onUpdateField: (updates: Partial<UpdateIssueRequest>) => void;
  currentUserId?: string;
}

/** Title, parent breadcrumb, description editor and the issue reaction bar. */
export function IssueDescriptionSection({
  issue,
  issueId,
  parentIssue,
  onUpdateField,
  currentUserId,
}: IssueDescriptionSectionProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const { getActorName } = useActorName();
  const { uploadWithToast } = useFileUpload(api);
  const { reactions, toggleReaction } = useIssueReactions(issueId, currentUserId);
  const [retitling, setRetitling] = useState(false);

  const updateCachedTitle = useCallback((title: string) => {
    queryClient.setQueryData<Issue>(issueKeys.detail(wsId, issueId), (current) =>
      current ? { ...current, title } : current,
    );
    void queryClient.invalidateQueries({ queryKey: issueKeys.all(wsId) });
  }, [issueId, queryClient, wsId]);

  const undoRetitle = useCallback(async (previousTitle: string) => {
    try {
      await api.patchIssue(issueId, { title: previousTitle });
      updateCachedTitle(previousTitle);
      toast.success(t(($) => $.detail.retitle_undo_success));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.detail.retitle_undo_failed));
    }
  }, [issueId, t, updateCachedTitle]);

  const retitle = useCallback(async () => {
    setRetitling(true);
    try {
      const result = await api.retitleIssue(issueId);
      if (result.reason === "kept") {
        toast.success(t(($) => $.detail.retitle_kept));
        return;
      }
      if (!result.applied || !result.title) {
        toast.error(t(($) => $.detail.retitle_failed));
        return;
      }
      updateCachedTitle(result.title);
      toast.success(t(($) => $.detail.retitle_success, {
        from: result.previous_title,
        to: result.title,
      }), {
        action: {
          label: t(($) => $.detail.retitle_undo),
          onClick: () => void undoRetitle(result.previous_title),
        },
      });
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.detail.retitle_failed));
    } finally {
      setRetitling(false);
    }
  }, [issueId, t, undoRetitle, updateCachedTitle]);

  // Attachments uploaded against this issue. Drives the description editor's
  // click-time fresh-sign download: NodeViews match `src`/`href` against this
  // list to resolve an attachment id before calling `/api/attachments/{id}`.
  const { data: issueAttachments } = useQuery(issueAttachmentsOptions(issueId));

  const descEditorRef = useRef<ContentEditorRef>(null);
  const { isDragOver: descDragOver, dropZoneProps: descDropZoneProps } = useFileDropZone({
    onDrop: (files) => files.forEach((f) => descEditorRef.current?.uploadFile(f)),
  });
  // Pending uploads in the description editor. We don't pass `issueId` on
  // upload (to avoid orphaning attachments when the user deletes the file
  // from the markdown), so they start unattached and we re-bind them via
  // `attachment_ids` on the next description save. Drives editor previews
  // so text/code attachments show an Eye before the bind round-trips.
  const [descPendingAttachments, setDescPendingAttachments] = useState<Attachment[]>([]);
  const descEditorAttachments = descPendingAttachments.length > 0
    ? [...(issueAttachments ?? []), ...descPendingAttachments]
    : issueAttachments;
  const handleDescriptionUpload = useCallback(
    async (file: File) => {
      const result = await uploadWithToast(file);
      if (result) setDescPendingAttachments((prev) => [...prev, result]);
      return result;
    },
    [uploadWithToast],
  );

  return (
    <>
      <div className="group/title flex min-w-0 items-start gap-1.5">
        <TitleEditor
          key={`title-${issueId}-${issue.title}`}
          defaultValue={issue.title}
          placeholder={t(($) => $.detail.title_placeholder)}
          className="min-w-0 flex-1 text-2xl font-bold leading-snug tracking-tight"
          onBlur={(value) => {
            const trimmed = value.trim();
            if (trimmed && trimmed !== issue.title) onUpdateField({ title: trimmed });
          }}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mt-0.5 shrink-0 text-muted-foreground opacity-60 transition-opacity sm:opacity-0 sm:group-hover/title:opacity-100 sm:focus-visible:opacity-100"
                aria-label={t(($) => $.detail.retitle_aria)}
                disabled={retitling}
                onClick={() => void retitle()}
              >
                {retitling
                  ? <Loader2 className="animate-spin" />
                  : <Sparkles />}
              </Button>
            }
          />
          <TooltipContent>{t(($) => $.detail.retitle_aria)}</TooltipContent>
        </Tooltip>
      </div>

      {parentIssue && <ParentIssueLink parentIssue={parentIssue} />}

      <div {...descDropZoneProps} className="relative mt-5 rounded-lg">
        <ContentEditor
          ref={descEditorRef}
          key={issueId}
          defaultValue={issue.description || ""}
          placeholder={t(($) => $.detail.desc_placeholder)}
          onUpdate={(md) => {
            // Bind any pending uploads still referenced in the markdown
            // so they appear in `issueAttachments` after refresh and the
            // editor's text/code preview keeps working past reload.
            const ids = descPendingAttachments
              .filter((a) => md.includes(a.url))
              .map((a) => a.id);
            onUpdateField({ description: md, attachment_ids: ids.length > 0 ? ids : undefined });
          }}
          onUploadFile={handleDescriptionUpload}
          debounceMs={1500}
          currentIssueId={issueId}
          attachments={descEditorAttachments}
        />

        <div className="flex items-center gap-1 mt-3">
          <ReactionBar
            reactions={reactions}
            currentUserId={currentUserId}
            onToggle={toggleReaction}
            getActorName={getActorName}
          />
          <FileUploadButton
            size="sm"
            onSelect={(file) => descEditorRef.current?.uploadFile(file)}
          />
        </div>
        {descDragOver && <FileDropOverlay />}
      </div>
    </>
  );
}
