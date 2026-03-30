import { useEffect, useState, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { Layout } from "../components/Layout";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { ArrowLeft, Save, Loader2, X, Plus, Rocket, CheckCircle, ExternalLink } from "lucide-react";
import * as api from "../api/client";
import type { PipelineConfig, Project } from "../api/types";
import { DEFAULT_PIPELINE_CONFIG } from "../api/types";

function Toggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
        enabled ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <Badge key={t} variant="secondary" className="gap-1 pr-1">
          <span className="max-w-[180px] truncate text-xs">{t}</span>
          <button
            type="button"
            onClick={() => onChange(tags.filter((x) => x !== t))}
            className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <div className="flex items-center gap-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder={placeholder ?? "输入 chatId..."}
          className="h-7 w-40 text-xs"
        />
        <Button size="sm" variant="ghost" onClick={addTag} className="h-7 w-7 p-0">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function ProjectConfig() {
  const [, params] = useRoute("/projects/:id/config");
  const [, navigate] = useLocation();
  const projectId = params?.id ?? "";

  const [project, setProject] = useState<Project | null>(null);
  const [config, setConfig] = useState<PipelineConfig>(DEFAULT_PIPELINE_CONFIG);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    Promise.all([api.getProjects(), api.getProjectConfig(projectId)])
      .then(([projects, cfg]) => {
        const p = projects.find((x) => x.id === projectId);
        setProject(p ?? null);
        setConfig({ ...DEFAULT_PIPELINE_CONFIG, ...cfg });
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.updateProjectConfig(projectId, config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [projectId, config]);

  const updateNotification = (
    key: "dailyChangelog" | "missionProgress" | "evalReport",
    field: "enabled" | "targets",
    value: boolean | string[],
  ) => {
    setConfig((prev) => ({
      ...prev,
      notifications: {
        ...prev.notifications,
        [key]: { ...prev.notifications[key], [field]: value },
      },
    }));
  };

  const updatePipeline = (key: keyof PipelineConfig["pipeline"], value: boolean | string) => {
    setConfig((prev) => ({
      ...prev,
      pipeline: { ...prev.pipeline, [key]: value },
    }));
  };

  if (loading) {
    return (
      <Layout title="项目设置">
        <div className="flex h-[60vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </Layout>
    );
  }

  if (!project) {
    return (
      <Layout title="项目设置">
        <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
          项目不存在
        </div>
      </Layout>
    );
  }

  const notifications: {
    key: "dailyChangelog" | "missionProgress" | "evalReport";
    label: string;
    desc: string;
  }[] = [
    { key: "dailyChangelog", label: "每日合入通知", desc: "汇总昨日 MR 合入情况" },
    { key: "missionProgress", label: "Mission 进度", desc: "任务执行进度实时推送" },
    { key: "evalReport", label: "评测报告", desc: "Contract 评估结果通知" },
  ];

  return (
    <Layout title={`项目设置 — ${project.name}`}>
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/projects")}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
            返回项目列表
          </Button>
          <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saved ? "已保存" : "保存配置"}
          </Button>
        </div>

        {/* Notifications */}
        <Card className="p-5">
          <h3 className="mb-4 text-sm font-medium">通知配置</h3>
          <div className="space-y-5">
            {notifications.map(({ key, label, desc }) => (
              <div key={key} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-xs text-muted-foreground">{desc}</div>
                  </div>
                  <Toggle
                    enabled={config.notifications[key].enabled}
                    onChange={(v) => updateNotification(key, "enabled", v)}
                  />
                </div>
                {config.notifications[key].enabled && (
                  <div className="ml-1">
                    <div className="mb-1 text-xs text-muted-foreground">推送群:</div>
                    <TagInput
                      tags={config.notifications[key].targets}
                      onChange={(t) => updateNotification(key, "targets", t)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* Pipeline */}
        <Card className="p-5">
          <h3 className="mb-4 text-sm font-medium">流水线配置</h3>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Release 分支</label>
              <Input
                value={config.pipeline.releaseBranch}
                onChange={(e) => updatePipeline("releaseBranch", e.target.value)}
                placeholder="release/1.0.0"
              />
              <div className="text-xs text-muted-foreground">MR 的目标分支，功能分支合入此分支</div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">跳过 RFC</div>
                <div className="text-xs text-muted-foreground">简单改动可跳过技术方案阶段</div>
              </div>
              <Toggle
                enabled={config.pipeline.skipRfc}
                onChange={(v) => updatePipeline("skipRfc", v)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">跳过任务拆解</div>
                <div className="text-xs text-muted-foreground">单任务不需要拆解</div>
              </div>
              <Toggle
                enabled={config.pipeline.skipDecompose}
                onChange={(v) => updatePipeline("skipDecompose", v)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm">测试命令</label>
              <Input
                value={config.pipeline.testCommand}
                onChange={(e) => updatePipeline("testCommand", e.target.value)}
                placeholder="bun test"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm">Lint 命令</label>
              <Input
                value={config.pipeline.lintCommand}
                onChange={(e) => updatePipeline("lintCommand", e.target.value)}
                placeholder="bun lint"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm">构建命令</label>
              <Input
                value={config.pipeline.buildCommand}
                onChange={(e) => updatePipeline("buildCommand", e.target.value)}
                placeholder="bun run build"
              />
            </div>
          </div>
        </Card>

        {/* Release */}
        {config.pipeline.releaseBranch && (
          <ReleaseSection projectId={projectId} releaseBranch={config.pipeline.releaseBranch} onNewBranch={(b) => updatePipeline("releaseBranch", b)} />
        )}
      </div>
    </Layout>
  );
}

function ReleaseSection({
  projectId,
  releaseBranch,
  onNewBranch,
}: {
  projectId: string;
  releaseBranch: string;
  onNewBranch: (branch: string) => void;
}) {
  const [step, setStep] = useState<"idle" | "creating" | "waiting" | "confirming" | "done">("idle");
  const [prUrl, setPrUrl] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ newBranch: string; newVersion: string } | null>(null);

  const version = releaseBranch.replace(/^release\//, "v");

  const handleCreatePR = async () => {
    setStep("creating");
    setError("");
    try {
      const res = await api.createReleasePR(projectId);
      setPrUrl(res.prUrl);
      setStep("waiting");
    } catch (e: any) {
      setError(e.message || "创建 PR 失败");
      setStep("idle");
    }
  };

  const handleConfirm = async () => {
    setStep("confirming");
    setError("");
    try {
      const res = await api.confirmReleaseMerge(projectId);
      setResult(res);
      onNewBranch(res.newBranch);
      setStep("done");
    } catch (e: any) {
      setError(e.message || "确认失败");
      setStep("waiting");
    }
  };

  return (
    <Card className="p-5">
      <h3 className="mb-4 text-sm font-medium">版本发布</h3>

      {error && (
        <div className="mb-3 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
      )}

      {step === "idle" && (
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            当前版本: <Badge variant="secondary">{version}</Badge> ({releaseBranch})
          </div>
          <Button onClick={handleCreatePR} size="sm" className="gap-1.5">
            <Rocket className="h-4 w-4" />
            发布 {version} → main
          </Button>
        </div>
      )}

      {step === "creating" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在创建 PR...
        </div>
      )}

      {step === "waiting" && (
        <div className="space-y-3">
          <div className="text-sm">
            PR 已创建，请在 GitHub 上 review 并合并:
          </div>
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {prUrl}
          </a>
          <div className="pt-2">
            <Button onClick={handleConfirm} size="sm" variant="outline" className="gap-1.5">
              <CheckCircle className="h-4 w-4" />
              确认已合入
            </Button>
          </div>
        </div>
      )}

      {step === "confirming" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在验证合入状态并创建新版本分支...
        </div>
      )}

      {step === "done" && result && (
        <div className="space-y-2">
          <div className="text-sm text-green-600">
            发布完成! 新版本分支: <Badge variant="secondary">{result.newBranch}</Badge>
          </div>
          <Button onClick={() => { setStep("idle"); setResult(null); }} size="sm" variant="ghost">
            返回
          </Button>
        </div>
      )}
    </Card>
  );
}
