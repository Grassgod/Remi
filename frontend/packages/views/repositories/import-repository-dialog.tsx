"use client";

import { useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import {
  useImportWorkspaceRepository,
  useInspectWorkspaceRepository,
} from "@multiremi/core/repositories";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
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
  const inspectRepository = useInspectWorkspaceRepository(workspaceId);
  const [url, setUrl] = useState("");
  const urlRef = useRef("");
  const [description, setDescription] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("");
  const [inspectedUrl, setInspectedUrl] = useState("");

  const reset = () => {
    setUrl("");
    urlRef.current = "";
    setDescription("");
    setBranches([]);
    setDefaultBranch("");
    setInspectedUrl("");
    inspectRepository.reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !importRepository.isPending && !inspectRepository.isPending) reset();
    onOpenChange(nextOpen);
  };

  const handleUrlChange = (nextUrl: string) => {
    setUrl(nextUrl);
    urlRef.current = nextUrl;
    setBranches([]);
    setDefaultBranch("");
    setInspectedUrl("");
  };

  const handleInspect = async () => {
    const normalizedUrl = url.trim();
    if (!normalizedUrl || inspectRepository.isPending) return;
    try {
      const response = await inspectRepository.mutateAsync(normalizedUrl);
      if (!response.metadata) throw new Error(t(($) => $.toast.inspect_failed));
      if (urlRef.current.trim() !== normalizedUrl) return;
      setBranches(response.metadata.branches);
      setDefaultBranch(response.metadata.default_branch);
      setInspectedUrl(normalizedUrl);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.toast.inspect_failed),
      );
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !url.trim()
      || !defaultBranch
      || inspectedUrl !== url.trim()
      || importRepository.isPending
    ) return;

    try {
      await importRepository.mutateAsync({
        url: url.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        default_branch: defaultBranch,
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
              <div className="flex items-center gap-2">
                <Input
                  id="repository-url"
                  value={url}
                  onChange={(event) => handleUrlChange(event.target.value)}
                  placeholder={t(($) => $.import_dialog.url_placeholder)}
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="none"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={handleInspect}
                  disabled={!url.trim() || inspectRepository.isPending}
                >
                  {inspectRepository.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {inspectRepository.isPending
                    ? t(($) => $.import_dialog.inspecting)
                    : t(($) => $.import_dialog.inspect)}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(($) => $.import_dialog.url_hint)}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="repository-default-branch">
                {t(($) => $.import_dialog.default_branch_label)}
              </Label>
              <Select
                value={defaultBranch || null}
                onValueChange={(value) => value && setDefaultBranch(value)}
                disabled={branches.length === 0 || inspectRepository.isPending}
              >
                <SelectTrigger
                  id="repository-default-branch"
                  className="w-full font-mono"
                  aria-label={t(($) => $.import_dialog.default_branch_label)}
                >
                  <SelectValue
                    placeholder={t(($) => $.import_dialog.default_branch_placeholder)}
                  >
                    {defaultBranch || null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" className="max-h-64">
                  {branches.map((branch) => (
                    <SelectItem key={branch} value={branch} className="font-mono text-xs">
                      {branch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              disabled={importRepository.isPending || inspectRepository.isPending}
            >
              {t(($) => $.import_dialog.cancel)}
            </Button>
            <Button
              type="submit"
              disabled={
                !url.trim()
                || !defaultBranch
                || inspectedUrl !== url.trim()
                || importRepository.isPending
                || inspectRepository.isPending
              }
            >
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
