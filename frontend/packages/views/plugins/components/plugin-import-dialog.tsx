"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Loader2,
  Puzzle,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@multiremi/core/api/client";
import type {
  AgentPlugin,
  AgentPluginProvider,
  AgentPluginRepositoryCandidate,
  AgentPluginRepositoryInspection,
  ImportAgentPluginRequest,
} from "@multiremi/core/plugins";
import {
  useImportAgentPlugin,
  useInspectAgentPluginRepository,
} from "@multiremi/core/plugins";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Badge } from "@multiremi/ui/components/ui/badge";
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
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multiremi/ui/components/ui/tabs";
import { useT } from "../../i18n";
import { BranchPicker } from "../../repositories/branch-picker";
import {
  parsePluginDirectory,
  PluginDirectoryError,
  type ParsedPluginDirectory,
} from "./plugin-directory";

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type ImportMode = "repository" | "directory";

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

function manifestVersion(directory: ParsedPluginDirectory): string {
  return typeof directory.manifest.version === "string"
    ? directory.manifest.version.trim()
    : "";
}

function candidateKey(candidate: AgentPluginRepositoryCandidate): string {
  return JSON.stringify([
    candidate.provider,
    candidate.sourceSubdir,
    candidate.manifestPath,
  ]);
}

function requirementsJson(plugin?: AgentPlugin): string {
  return JSON.stringify(plugin?.activeVersion?.requirements ?? {}, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function apiErrorCode(cause: unknown): string {
  return cause instanceof ApiError && isRecord(cause.body)
    ? String(cause.body.code ?? "")
    : "";
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
  const sourceUrlRef = useRef(targetPlugin?.sourceUrl ?? "");
  const inspectRequestRef = useRef(0);
  const directoryRequestRef = useRef(0);
  const previousTargetIdRef = useRef(targetPlugin?.id);
  const mutation = useImportAgentPlugin(wsId);
  const inspectMutation = useInspectAgentPluginRepository(wsId);
  const [mode, setMode] = useState<ImportMode>("repository");
  const [directory, setDirectory] = useState<ParsedPluginDirectory | null>(null);
  const [sourceUrl, setSourceUrl] = useState(targetPlugin?.sourceUrl ?? "");
  const [sourceRef, setSourceRef] = useState(targetPlugin?.sourceRef ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [remoteDefaultBranch, setRemoteDefaultBranch] = useState("");
  const [inspection, setInspection] =
    useState<AgentPluginRepositoryInspection | null>(null);
  const [selectedCandidateKey, setSelectedCandidateKey] = useState("");
  const [requirementsText, setRequirementsText] = useState(
    requirementsJson(targetPlugin),
  );
  const [isReading, setIsReading] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [canUseDefaultBranch, setCanUseDefaultBranch] = useState(false);

  const reset = () => {
    inspectRequestRef.current += 1;
    directoryRequestRef.current += 1;
    setMode("repository");
    setDirectory(null);
    setIsReading(false);
    const nextUrl = targetPlugin?.sourceUrl ?? "";
    setSourceUrl(nextUrl);
    sourceUrlRef.current = nextUrl;
    setSourceRef(targetPlugin?.sourceRef ?? "");
    setBranches([]);
    setRemoteDefaultBranch("");
    setInspection(null);
    setSelectedCandidateKey("");
    setRequirementsText(requirementsJson(targetPlugin));
    setFieldError(null);
    setCanUseDefaultBranch(false);
    inspectMutation.reset();
    if (inputRef.current) inputRef.current.value = "";
  };

  useEffect(() => {
    const targetChanged = previousTargetIdRef.current !== targetPlugin?.id;
    if (!open || targetChanged) reset();
    previousTargetIdRef.current = targetPlugin?.id;
    // Reset when the dialog closes or switches to another target Plugin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPlugin?.id]);

  const providerLabel = t(($) => $.provider[provider]);
  const isPending = mutation.isPending || inspectMutation.isPending || isReading;
  const compatibleCandidates = (inspection?.candidates ?? []).filter(
    (candidate) => !targetPlugin || candidate.provider === targetPlugin.provider,
  );
  const selectedCandidate = compatibleCandidates.find(
    (candidate) => candidateKey(candidate) === selectedCandidateKey,
  ) ?? null;

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

  const repositoryErrorMessage = (cause: unknown): string => {
    const code = apiErrorCode(cause);
    switch (code) {
      case "plugin_manifest_not_found":
        return t(($) => $.import.errors.manifest_missing);
      case "plugin_manifest_invalid":
      case "plugin_manifest_path_invalid":
        return t(($) => $.import.errors.invalid_manifest);
      case "plugin_version_missing":
        return t(($) => $.import.errors.missing_codex_version);
      case "plugin_version_invalid":
        return t(($) => $.import.errors.invalid_version);
      case "plugin_artifact_too_large":
      case "plugin_git_output_too_large":
        return t(($) => $.import.errors.artifact_too_large);
      case "plugin_git_revision_changed":
        return t(($) => $.import.errors.repository_changed);
      case "plugin_git_ref_not_found":
      case "plugin_git_ref_invalid":
        return t(($) => $.import.errors.source_ref_unavailable);
      case "plugin_selection_required":
        return t(($) => $.import.errors.plugin_selection_required);
      case "plugin_git_url_invalid":
        return t(($) => $.import.errors.invalid_repository_url);
      case "plugin_git_timeout":
        return t(($) => $.import.errors.repository_timeout);
      case "plugin_git_remote_unavailable":
      case "plugin_git_fetch_failed":
        return t(($) => $.import.errors.repository_unavailable);
      default:
        return t(($) => $.import.errors.repository_read_failed);
    }
  };

  const clearInspection = () => {
    inspectRequestRef.current += 1;
    setInspection(null);
    setSelectedCandidateKey("");
    setCanUseDefaultBranch(false);
  };

  const handleSourceUrlChange = (nextUrl: string) => {
    setSourceUrl(nextUrl);
    sourceUrlRef.current = nextUrl;
    setSourceRef("");
    setBranches([]);
    setRemoteDefaultBranch("");
    clearInspection();
    setFieldError(null);
  };

  const inspectRepository = async (nextRef = sourceRef) => {
    const normalizedUrl = sourceUrl.trim();
    const normalizedRef = nextRef.trim();
    if (!normalizedUrl || inspectMutation.isPending) return;
    const requestId = ++inspectRequestRef.current;
    setFieldError(null);
    setCanUseDefaultBranch(false);
    try {
      const response = await inspectMutation.mutateAsync({
        sourceUrl: normalizedUrl,
        sourceRef: normalizedRef || null,
      });
      if (
        requestId !== inspectRequestRef.current
        || sourceUrlRef.current.trim() !== normalizedUrl
      ) return;
      if (!response) {
        setInspection(null);
        setFieldError(t(($) => $.import.errors.repository_read_failed));
        return;
      }
      const candidates = response.candidates.filter(
        (candidate) => !targetPlugin || candidate.provider === targetPlugin.provider,
      );
      if (candidates.length === 0) {
        setInspection(null);
        setFieldError(
          targetPlugin
            ? t(($) => $.import.errors.provider_mismatch, {
                provider: t(($) => $.provider[targetPlugin.provider]),
              })
            : t(($) => $.import.errors.manifest_missing),
        );
        return;
      }
      setInspection(response);
      setBranches(response.branches);
      setRemoteDefaultBranch(response.defaultBranch);
      setSourceRef(response.sourceRef);
      const preferred = targetPlugin
        ? candidates.find((candidate) => (
            candidate.provider === targetPlugin.provider
            && candidate.sourceSubdir === (targetPlugin.sourceSubdir ?? "")
          )) ?? null
        : candidates.length === 1
          ? candidates[0]
          : null;
      setSelectedCandidateKey(preferred ? candidateKey(preferred) : "");
    } catch (cause) {
      if (requestId !== inspectRequestRef.current) return;
      setInspection(null);
      const code = apiErrorCode(cause);
      setCanUseDefaultBranch(Boolean(normalizedRef) && (
        code === "plugin_git_ref_not_found" || code === "plugin_git_ref_invalid"
      ));
      setFieldError(repositoryErrorMessage(cause));
    }
  };

  const handleRefChange = async (nextRef: string) => {
    setSourceRef(nextRef);
    setInspection(null);
    setSelectedCandidateKey("");
    await inspectRepository(nextRef);
  };

  const handleUseDefaultBranch = async () => {
    setSourceRef("");
    setBranches([]);
    setRemoteDefaultBranch("");
    clearInspection();
    await inspectRepository("");
  };

  const handleDirectoryChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    const input = event.currentTarget;
    const requestId = ++directoryRequestRef.current;
    setIsReading(true);
    setFieldError(null);
    try {
      const parsed = await parsePluginDirectory(files);
      if (requestId !== directoryRequestRef.current) return;
      if (targetPlugin && parsed.provider !== targetPlugin.provider) {
        setDirectory(null);
        setFieldError(
          t(($) => $.import.errors.provider_mismatch, {
            provider: t(($) => $.provider[targetPlugin.provider]),
          }),
        );
        return;
      }
      const version = manifestVersion(parsed);
      if (version && !SEMVER_PATTERN.test(version)) {
        setDirectory(null);
        setFieldError(t(($) => $.import.errors.invalid_version));
        return;
      }
      if (!version && parsed.provider === "codex") {
        setDirectory(null);
        setFieldError(t(($) => $.import.errors.missing_codex_version));
        return;
      }
      setDirectory(parsed);
    } catch (cause) {
      if (requestId !== directoryRequestRef.current) return;
      setDirectory(null);
      setFieldError(directoryErrorMessage(cause));
    } finally {
      if (requestId === directoryRequestRef.current) setIsReading(false);
      input.value = "";
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const handleImport = async () => {
    let requirements: Record<string, unknown>;
    try {
      const parsed = JSON.parse(requirementsText.trim() || "{}");
      if (!isRecord(parsed)) throw new Error("invalid requirements");
      requirements = parsed;
    } catch {
      setFieldError(t(($) => $.import.errors.invalid_requirements));
      return;
    }

    let input: ImportAgentPluginRequest;
    if (mode === "repository") {
      if (!inspection || !selectedCandidate) return;
      input = {
        mode: "git",
        ...(targetPlugin ? { id: targetPlugin.id } : {}),
        workspaceId: wsId,
        sourceUrl: inspection.sourceUrl,
        sourceRef: inspection.sourceRef,
        sourceSubdir: selectedCandidate.sourceSubdir,
        provider: selectedCandidate.provider,
        manifestPath: selectedCandidate.manifestPath,
        expectedRevision: inspection.sourceRevision,
        requirements,
        activate: !targetPlugin,
      };
    } else {
      if (!directory) return;
      input = {
        ...(targetPlugin
          ? {
              id: targetPlugin.id,
              name: targetPlugin.name,
              description: targetPlugin.description,
            }
          : {}),
        workspaceId: wsId,
        provider: directory.provider,
        manifestPath: directory.manifestPath,
        manifest: directory.manifest,
        files: directory.files,
        sourceType: targetPlugin?.sourceType ?? "manifest",
        sourceUrl: targetPlugin?.sourceUrl ?? null,
        sourceRef: targetPlugin?.sourceRef ?? null,
        sourceSubdir: targetPlugin?.sourceSubdir ?? null,
        requirements,
        activate: !targetPlugin,
      };
    }

    setFieldError(null);
    try {
      const plugin = await mutation.mutateAsync(input);
      if (!plugin) {
        toast.error(t(($) => $.import.failed_toast));
        return;
      }
      toast.success(
        targetPlugin
          ? t(($) => $.import.version_success_toast)
          : t(($) => $.import.success_toast),
      );
      reset();
      onOpenChange(false);
      onImported?.(plugin);
    } catch (cause) {
      toast.error(
        mode === "repository"
          ? repositoryErrorMessage(cause)
          : cause instanceof Error && cause.message
            ? cause.message
            : t(($) => $.import.failed_toast),
      );
    }
  };

  const renderCandidate = (candidate: AgentPluginRepositoryCandidate) => (
    <PluginSummary
      name={candidate.name}
      version={candidate.version}
      manifestPath={
        candidate.sourceSubdir
          ? `${candidate.sourceSubdir}/${candidate.manifestPath}`
          : candidate.manifestPath
      }
      fileCount={candidate.fileCount}
      totalBytes={candidate.artifactSize}
      revision={inspection?.sourceRevision ?? null}
      providerName={t(($) => $.provider[candidate.provider])}
      automaticVersionLabel={t(($) => $.import.automatic_version)}
      summaryLabel={candidate.artifactSizeKnown === false
        ? t(($) => $.import.repository_folder_summary, {
            count: candidate.fileCount,
          })
        : t(($) => $.import.folder_summary, {
            count: candidate.fileCount,
            size: formatBytes(candidate.artifactSize),
          })}
    />
  );

  const localVersion = directory ? manifestVersion(directory) : "";
  const canSubmit = mode === "repository"
    ? Boolean(inspection && selectedCandidate)
    : Boolean(directory);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {targetPlugin
              ? t(($) => $.import.version_title, { plugin: targetPlugin.name })
              : t(($) => $.import.title)}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {targetPlugin
              ? t(($) => $.import.version_description, { provider: providerLabel })
              : t(($) => $.import.description)}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={mode}
          onValueChange={(value) => {
            setMode(value as ImportMode);
            setFieldError(null);
          }}
          className="gap-4"
        >
          <TabsList className="grid w-full grid-cols-2" aria-label={t(($) => $.import.source_label)}>
            <TabsTrigger value="repository">
              <GitBranch className="size-3.5" />
              {t(($) => $.import.repository_tab)}
            </TabsTrigger>
            <TabsTrigger value="directory">
              <FolderOpen className="size-3.5" />
              {t(($) => $.import.directory_tab)}
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="repository"
            className="space-y-4"
            aria-busy={inspectMutation.isPending}
          >
            <div className="space-y-1.5">
              <Label htmlFor="plugin-source-url">
                {t(($) => $.import.repository_url_label)}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="plugin-source-url"
                  value={sourceUrl}
                  onChange={(event) => handleSourceUrlChange(event.target.value)}
                  placeholder={t(($) => $.import.repository_url_placeholder)}
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="none"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void inspectRepository();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  disabled={!sourceUrl.trim() || inspectMutation.isPending}
                  onClick={() => void inspectRepository()}
                >
                  {inspectMutation.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RefreshCw />
                  )}
                  {inspectMutation.isPending
                    ? t(($) => $.import.inspecting_action)
                    : t(($) => $.import.inspect_action)}
                </Button>
              </div>
            </div>

            {(branches.length > 0 || sourceRef) && (
              <div className="space-y-1.5">
                <Label htmlFor="plugin-source-ref">
                  {t(($) => $.import.source_ref_label)}
                </Label>
                <BranchPicker
                  id="plugin-source-ref"
                  value={sourceRef}
                  branches={branches}
                  remoteDefaultBranch={remoteDefaultBranch}
                  onValueChange={handleRefChange}
                  disabled={inspectMutation.isPending}
                  loading={inspectMutation.isPending}
                  allowCustomValue
                  customValueHeading={t(($) => $.import.custom_ref_heading)}
                  searchPlaceholder={t(($) => $.import.source_ref_search_placeholder)}
                  ariaLabel={t(($) => $.import.source_ref_label)}
                  placeholder={t(($) => $.import.source_ref_placeholder)}
                  triggerClassName="w-full"
                  contentClassName="w-[var(--anchor-width)]"
                />
              </div>
            )}

            {(compatibleCandidates.length > 1
              || Boolean(targetPlugin && inspection && !selectedCandidate)) && (
              <div className="space-y-1.5">
                <Label htmlFor="plugin-source-subdir">
                  {t(($) => $.import.plugin_label)}
                </Label>
                <Select
                  value={selectedCandidateKey}
                  onValueChange={(value) => setSelectedCandidateKey(value ?? "")}
                >
                  <SelectTrigger
                    id="plugin-source-subdir"
                    aria-label={t(($) => $.import.plugin_label)}
                    className="w-full"
                  >
                    <SelectValue placeholder={t(($) => $.import.plugin_placeholder)} />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {compatibleCandidates.map((candidate) => (
                      <SelectItem
                        key={candidateKey(candidate)}
                        value={candidateKey(candidate)}
                      >
                        <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {t(($) => $.provider[candidate.provider])}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {candidate.sourceSubdir || "."}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedCandidate && renderCandidate(selectedCandidate)}
          </TabsContent>

          <TabsContent value="directory" className="space-y-4">
            <input
              ref={inputRef}
              type="file"
              multiple
              className="sr-only"
              aria-label={t(($) => $.import.folder_label)}
              onChange={(event) => void handleDirectoryChange(event)}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
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
              <PluginSummary
                name={String(directory.manifest.name ?? directory.folderName)}
                version={localVersion}
                manifestPath={directory.manifestPath}
                fileCount={directory.fileCount}
                totalBytes={directory.totalBytes}
                providerName={t(($) => $.provider[directory.provider])}
                automaticVersionLabel={t(($) => $.import.automatic_version)}
                summaryLabel={t(($) => $.import.folder_summary, {
                  count: directory.fileCount,
                  size: formatBytes(directory.totalBytes),
                })}
              />
            )}
          </TabsContent>
        </Tabs>

        <details className="group rounded-md border border-dashed">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight
              className="size-3.5 transition-transform group-open:rotate-90"
              aria-hidden
            />
            {t(($) => $.import.advanced_title)}
          </summary>
          <div className="space-y-1.5 border-t px-3 py-3">
            <Label htmlFor="plugin-runtime-requirements">
              {t(($) => $.import.requirements_label)}
            </Label>
            <Textarea
              id="plugin-runtime-requirements"
              value={requirementsText}
              onChange={(event) => {
                setRequirementsText(event.target.value);
                setFieldError(null);
              }}
              className="min-h-24 font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              {t(($) => $.import.requirements_hint)}
            </p>
          </div>
        </details>

        {targetPlugin && canSubmit && (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t(($) => $.import.candidate_notice)}
          </p>
        )}

        {fieldError && (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="min-w-0 text-xs text-destructive">
              {fieldError}
            </p>
            {mode === "repository" && canUseDefaultBranch && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={inspectMutation.isPending}
                onClick={() => void handleUseDefaultBranch()}
              >
                <GitBranch />
                {t(($) => $.import.use_default_branch_action)}
              </Button>
            )}
          </div>
        )}

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
            disabled={isPending || !canSubmit}
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

function PluginSummary({
  name,
  version,
  manifestPath,
  summaryLabel,
  revision,
  providerName,
  automaticVersionLabel,
}: {
  name: string;
  version: string;
  manifestPath: string;
  fileCount: number;
  totalBytes: number;
  summaryLabel: string;
  revision?: string | null;
  providerName: string;
  automaticVersionLabel: string;
}) {
  return (
    <div
      className="rounded-md border px-3 py-3"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Puzzle className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <Badge variant="outline" className="capitalize">
              {providerName}
            </Badge>
            <Badge variant="secondary" className="font-mono font-normal">
              {version || automaticVersionLabel}
            </Badge>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {manifestPath}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {summaryLabel}
            {revision ? ` · ${revision.slice(0, 12)}` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}
