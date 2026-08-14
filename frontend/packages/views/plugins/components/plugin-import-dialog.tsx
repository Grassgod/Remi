"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Loader2,
  Puzzle,
} from "lucide-react";
import { toast } from "sonner";
import type {
  AgentPlugin,
  AgentPluginProvider,
  ImportAgentPluginInput,
} from "@multiremi/core/plugins";
import { useImportAgentPlugin } from "@multiremi/core/plugins";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multiremi/ui/components/ui/collapsible";
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
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { useT } from "../../i18n";
import {
  parsePluginDirectory,
  PluginDirectoryError,
  type ParsedPluginDirectory,
} from "./plugin-directory";

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function PluginImportDialog({
  provider,
  targetPlugin,
  open,
  onOpenChange,
  onImported,
}: {
  provider: AgentPluginProvider;
  targetPlugin?: AgentPlugin;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (plugin: AgentPlugin) => void;
}) {
  const { t } = useT("plugins");
  const wsId = useWorkspaceId();
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useImportAgentPlugin(wsId);
  const [directory, setDirectory] = useState<ParsedPluginDirectory | null>(null);
  const [version, setVersion] = useState("0.1.0");
  const [sourceUrl, setSourceUrl] = useState(targetPlugin?.sourceUrl ?? "");
  const [sourceRef, setSourceRef] = useState(targetPlugin?.sourceRef ?? "");
  const [requirementsText, setRequirementsText] = useState(
    JSON.stringify(targetPlugin?.activeVersion?.requirements ?? {}, null, 2),
  );
  const [isReading, setIsReading] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const reset = () => {
    setDirectory(null);
    setVersion("0.1.0");
    setSourceUrl(targetPlugin?.sourceUrl ?? "");
    setSourceRef(targetPlugin?.sourceRef ?? "");
    setRequirementsText(
      JSON.stringify(targetPlugin?.activeVersion?.requirements ?? {}, null, 2),
    );
    setFieldError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  useEffect(() => {
    if (!open) reset();
  // Reset only when the dialog closes; target metadata is captured by reset.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const providerLabel = t(($) => $.provider[provider]);
  const isPending = mutation.isPending || isReading;

  const directoryErrorMessage = (cause: unknown): string => {
    if (!(cause instanceof PluginDirectoryError)) {
      return t(($) => $.import.errors.read_failed);
    }
    switch (cause.code) {
      case "empty_directory":
        return t(($) => $.import.errors.empty_directory);
      case "too_many_files":
        return t(($) => $.import.errors.too_many_files);
      case "artifact_too_large":
        return t(($) => $.import.errors.artifact_too_large);
      case "manifest_missing":
        return t(($) => $.import.errors.manifest_missing);
      case "multiple_manifests":
        return t(($) => $.import.errors.multiple_manifests);
      case "invalid_manifest":
        return t(($) => $.import.errors.invalid_manifest);
      case "invalid_directory":
        return t(($) => $.import.errors.invalid_directory);
    }
  };

  const handleDirectoryChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setIsReading(true);
    setFieldError(null);
    try {
      const parsed = await parsePluginDirectory(files);
      if (targetPlugin && parsed.provider !== targetPlugin.provider) {
        setDirectory(null);
        setFieldError(
          t(($) => $.import.errors.provider_mismatch, {
            provider: t(($) => $.provider[targetPlugin.provider]),
          }),
        );
        return;
      }
      setDirectory(parsed);
      const manifestVersion =
        typeof parsed.manifest.version === "string"
          ? parsed.manifest.version.trim()
          : "";
      setVersion(
        SEMVER_PATTERN.test(manifestVersion) ? manifestVersion : "0.1.0",
      );
    } catch (cause) {
      setDirectory(null);
      setFieldError(directoryErrorMessage(cause));
    } finally {
      setIsReading(false);
      event.target.value = "";
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && !isPending) reset();
    onOpenChange(next);
  };

  const handleImport = async () => {
    if (!directory) return;
    const normalizedVersion = version.trim();
    if (!SEMVER_PATTERN.test(normalizedVersion)) {
      setFieldError(t(($) => $.import.errors.invalid_version));
      return;
    }
    const requirements = parseRecord(requirementsText);
    if (!requirements) {
      setFieldError(t(($) => $.import.errors.invalid_requirements));
      return;
    }
    setFieldError(null);
    const input: ImportAgentPluginInput = {
      ...(targetPlugin
        ? {
            id: targetPlugin.id,
            name: targetPlugin.name,
            description: targetPlugin.description,
          }
        : {}),
      workspaceId: wsId,
      provider: directory.provider,
      version: normalizedVersion,
      manifestPath: directory.manifestPath,
      manifest: directory.manifest,
      files: directory.files,
      sourceType: targetPlugin?.sourceType ?? "manifest",
      sourceUrl: sourceUrl.trim() || null,
      sourceRef: sourceRef.trim() || null,
      sourceRevision: sourceRef.trim() || null,
      requirements,
      activate: !targetPlugin,
    };

    try {
      const plugin = await mutation.mutateAsync(input);
      toast.success(
        targetPlugin
          ? t(($) => $.import.version_success_toast)
          : t(($) => $.import.success_toast),
      );
      reset();
      onOpenChange(false);
      if (plugin) onImported?.(plugin);
    } catch (cause) {
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : t(($) => $.import.failed_toast),
      );
    }
  };

  const detectedProvider = directory?.provider ?? provider;
  const detectedName = String(directory?.manifest.name ?? "");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[min(90vh,720px)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {targetPlugin
              ? t(($) => $.import.version_title, { plugin: targetPlugin.name })
              : t(($) => $.import.title)}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {targetPlugin
              ? t(($) => $.import.version_description, {
                  provider: providerLabel,
                })
              : t(($) => $.import.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label={t(($) => $.import.folder_label)}
            onChange={(event) => void handleDirectoryChange(event)}
            {...({ webkitdirectory: "", directory: "" } as Record<
              string,
              string
            >)}
          />

          <button
            type="button"
            className="flex w-full flex-col items-center justify-center rounded-md border border-dashed px-5 py-8 text-center transition-colors hover:border-foreground/30 hover:bg-muted/30 disabled:pointer-events-none disabled:opacity-50"
            disabled={isPending}
            onClick={() => inputRef.current?.click()}
          >
            {isReading ? (
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            ) : directory ? (
              <CheckCircle2 className="h-6 w-6 text-success" />
            ) : (
              <FolderOpen className="h-6 w-6 text-muted-foreground" />
            )}
            <span className="mt-3 text-sm font-medium">
              {directory
                ? t(($) => $.import.change_folder_action)
                : t(($) => $.import.choose_folder_action)}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              {t(($) => $.import.folder_hint)}
            </span>
          </button>

          {directory && (
            <div className="rounded-md border px-3 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Puzzle className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {detectedName || directory.folderName}
                    </span>
                    <Badge variant="outline" className="capitalize">
                      {t(($) => $.provider[detectedProvider])}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {directory.manifestPath}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t(($) => $.import.folder_summary, {
                      count: directory.fileCount,
                      size: formatBytes(directory.totalBytes),
                    })}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="plugin-import-version">
              {t(($) => $.import.version_label)}
            </Label>
            <Input
              id="plugin-import-version"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder="0.1.0"
              spellCheck={false}
              className="font-mono"
              aria-invalid={
                Boolean(version.trim()) && !SEMVER_PATTERN.test(version.trim())
              }
            />
            <p className="text-[11px] text-muted-foreground">
              {t(($) => $.import.version_hint)}
            </p>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md py-1 text-xs font-medium">
              {t(($) => $.import.advanced_title)}
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="plugin-source-url">
                    {t(($) => $.import.source_url_label)}
                  </Label>
                  <Input
                    id="plugin-source-url"
                    value={sourceUrl}
                    onChange={(event) => setSourceUrl(event.target.value)}
                    placeholder={t(($) => $.import.source_url_placeholder)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="plugin-source-ref">
                    {t(($) => $.import.source_ref_label)}
                  </Label>
                  <Input
                    id="plugin-source-ref"
                    value={sourceRef}
                    onChange={(event) => setSourceRef(event.target.value)}
                    placeholder={t(($) => $.import.source_ref_placeholder)}
                  />
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                <Label htmlFor="plugin-requirements">
                  {t(($) => $.import.requirements_label)}
                </Label>
                <Textarea
                  id="plugin-requirements"
                  value={requirementsText}
                  onChange={(event) => setRequirementsText(event.target.value)}
                  placeholder={'{"binaries":["lark-cli"]}'}
                  spellCheck={false}
                  className="min-h-24 resize-y font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  {t(($) => $.import.requirements_hint)}
                </p>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {targetPlugin && directory && (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t(($) => $.import.candidate_notice)}
            </p>
          )}

          {fieldError && (
            <p role="alert" className="text-xs text-destructive">
              {fieldError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={() => handleOpenChange(false)}
          >
            {t(($) => $.import.cancel_action)}
          </Button>
          <Button
            type="button"
            disabled={isPending || !directory}
            onClick={() => void handleImport()}
          >
            {mutation.isPending && <Loader2 className="animate-spin" />}
            {mutation.isPending
              ? t(($) => $.import.submitting_action)
              : targetPlugin
                ? t(($) => $.import.submit_version_action)
                : t(($) => $.import.submit_action)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
