/**
 * Mission Board data model — type definitions.
 */

// ── Mission Status ──

export type MissionStatus =
  | "inbox"        // 需求澄清完成，等待审批
  | "approved"     // 已批准，排队执行
  | "in_progress"  // 流水线执行中
  | "in_review"    // 执行完成，等待验收
  | "done"         // MR 合入 / 验收通过
  | "rejected"     // 驳回
  | "blocked";     // 异常/超时，需人工介入

// ── Pipeline Step ──

export type PipelineStep =
  | "intake"       // 需求澄清
  | "rfc"          // RFC / Proposal + Task 拆解
  | "execute"      // 编码执行
  | "eval"         // Contract 验证
  | "summary";     // 总结

// ── Contract ──

export interface ContractCase {
  id: string;
  description: string;
  input: string;
  expectedOutput: string;
  type: "unit" | "integration" | "e2e";
}

export interface ContractVerification {
  caseResults: Array<{ caseId: string; passed: boolean; detail: string }>;
  overallPassed: boolean;
  verifiedAt: string;
}

export interface Contract {
  cases: ContractCase[];
  acceptanceCriteria: string[];
  verificationResults?: ContractVerification;
}

// ── Mission ──

export interface Mission {
  id: string;
  title: string;
  description: string | null;
  status: MissionStatus;
  projectId: string;

  // 飞书关联
  chatId: string;
  threadId: string | null;

  // 流水线
  currentStep: PipelineStep;
  contract: Contract | null;
  mrUrl: string | null;
  mrStatus: string | null;  // open | merged | closed

  // 步骤产出
  outputDir: string | null;

  // Claude Code session 管理 (intake, plan, exec → real UUID)
  sessions: Record<string, string>;

  // 元数据
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  releasedAt: string | null;

  // 统计
  totalTokens: number;
  totalCost: number;
  totalDuration: number;
}

// ── Mission Create Input ──

export interface MissionCreate {
  title: string;
  description?: string;
  projectId: string;
  chatId: string;
  threadId?: string;
  createdBy?: string;
  createdByName?: string;
}

// ── Skill Feedback ──

export type FeedbackType = "rejected" | "review_revision" | "contract_fail" | "timeout";

export interface SkillFeedback {
  id: string;
  missionId: string;
  step: PipelineStep;
  skillName: string;
  feedbackType: FeedbackType;
  detail: string | null;
  createdAt: string;
}

// ── Project Config (enhanced) ──

export interface ProjectConfig {
  cwd: string;
  repoUrl?: string;
  repoType?: "github" | "codebase";
  chatId?: string;
}
