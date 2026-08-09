"use client";

import { useState } from "react";
import { useImportWorkspaceRepository } from "@multiremi/core/repositories";
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
import { toast } from "sonner";
import { useT } from "../i18n";

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
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");

  const reset = () => {
    setUrl("");
    setDescription("");
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
        url: url.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
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
              <Label htmlFor="repository-url">{t(($) => $.import_dialog.url_label)}</Label>
              <Input
                id="repository-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t(($) => $.import_dialog.url_placeholder)}
                autoFocus
                spellCheck={false}
                autoCapitalize="none"
              />
              <p className="text-xs text-muted-foreground">
                {t(($) => $.import_dialog.url_hint)}
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
