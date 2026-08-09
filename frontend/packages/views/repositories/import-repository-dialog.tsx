"use client";

import { useState } from "react";
import { GitBranch } from "lucide-react";
import { useImportWorkspaceRepository } from "@multiremi/core/repositories";
import type { WorkspaceRepositorySource } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { useT } from "../i18n";
import { GitHubMark } from "../settings/components/github-mark";

interface ImportRepositoryDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportRepositoryDialog({
  workspaceId,
  open,
  onOpenChange,
}: ImportRepositoryDialogProps) {
  const { t } = useT("repositories");
  const importRepository = useImportWorkspaceRepository(workspaceId);
  const [source, setSource] = useState<WorkspaceRepositorySource>("github");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  const reset = () => {
    setSource("github");
    setUrl("");
    setDescription("");
    setDefaultBranch("");
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !importRepository.isPending) reset();
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!url.trim() || importRepository.isPending) return;

    try {
      await importRepository.mutateAsync({
        source,
        url: url.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(defaultBranch.trim() ? { default_branch: defaultBranch.trim() } : {}),
      });
      toast.success(t(($) => $.toast.imported));
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.toast.import_failed),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{t(($) => $.import_dialog.title)}</DialogTitle>
            <DialogDescription>{t(($) => $.import_dialog.description)}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t(($) => $.import_dialog.source_label)}</Label>
              <div className="grid grid-cols-2 rounded-lg bg-muted p-0.5">
                <button
                  type="button"
                  aria-pressed={source === "github"}
                  onClick={() => setSource("github")}
                  className={cn(
                    "flex h-8 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors",
                    source === "github"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <GitHubMark className="size-4" />
                  {t(($) => $.sources.github)}
                </button>
                <button
                  type="button"
                  aria-pressed={source === "codebase"}
                  onClick={() => setSource("codebase")}
                  className={cn(
                    "flex h-8 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors",
                    source === "codebase"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <GitBranch className="size-4" />
                  {t(($) => $.sources.codebase)}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="repository-url">{t(($) => $.import_dialog.url_label)}</Label>
              <Input
                id="repository-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={
                  source === "github"
                    ? t(($) => $.import_dialog.github_url_placeholder)
                    : t(($) => $.import_dialog.codebase_url_placeholder)
                }
                autoFocus
                spellCheck={false}
                autoCapitalize="none"
              />
              <p className="text-xs text-muted-foreground">
                {source === "github"
                  ? t(($) => $.import_dialog.github_hint)
                  : t(($) => $.import_dialog.codebase_hint)}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="repository-description">
                {t(($) => $.import_dialog.description_label)}
                <span className="ml-1 font-normal text-muted-foreground">
                  {t(($) => $.import_dialog.optional)}
                </span>
              </Label>
              <Input
                id="repository-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t(($) => $.import_dialog.description_placeholder)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="repository-default-branch">
                {t(($) => $.import_dialog.default_branch_label)}
                <span className="ml-1 font-normal text-muted-foreground">
                  {t(($) => $.import_dialog.optional)}
                </span>
              </Label>
              <Input
                id="repository-default-branch"
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
                placeholder={t(($) => $.import_dialog.default_branch_placeholder)}
                spellCheck={false}
                autoCapitalize="none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={importRepository.isPending}
            >
              {t(($) => $.import_dialog.cancel)}
            </Button>
            <Button type="submit" disabled={!url.trim() || importRepository.isPending}>
              {importRepository.isPending
                ? t(($) => $.import_dialog.importing)
                : t(($) => $.import_dialog.submit)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
