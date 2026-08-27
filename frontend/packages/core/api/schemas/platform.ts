import { z } from "zod";

export const PlatformReleaseSchema = z.object({
  version: z.string().default(""),
  ref: z.string().default(""),
  publishedAt: z.string().nullable().default(null),
  releaseUrl: z.string().nullable().default(null),
  manifestUrl: z.string().nullable().default(null),
  apiImage: z.string().nullable().default(null),
  webImage: z.string().nullable().default(null),
}).loose();

export const PlatformDrainProgressSchema = z.object({
  generation: z.number().default(0),
  online_daemons: z.number().default(0),
  acked_daemons: z.number().default(0),
  active_tasks: z.number().default(0),
  waited_ms: z.number().default(0),
  timeout_ms: z.number().default(0),
  state: z.string().default("waiting"),
}).loose();

export const PlatformOperationProgressSchema = z.object({
  message: z.string().default(""),
  drain: PlatformDrainProgressSchema.nullable().default(null),
}).loose();

export const PlatformOperationSchema = z.object({
  id: z.string().default(""),
  kind: z.string().default("check_updates"),
  status: z.string().default("queued"),
  driver: z.string().default("systemd_release"),
  targetVersion: z.string().nullable().default(null),
  targetRef: z.string().nullable().default(null),
  targetManifest: z.record(z.string(), z.unknown()).default({}),
  progress: PlatformOperationProgressSchema.default({ message: "", drain: null }),
  cancelRequested: z.boolean().default(false),
  requestedBy: z.string().default(""),
  output: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  previousRelease: PlatformReleaseSchema.nullable().default(null),
  resultRelease: PlatformReleaseSchema.nullable().default(null),
  createdAt: z.string().default(""),
  updatedAt: z.string().default(""),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
}).loose();

export const PlatformMaintenanceSchema = z.object({
  mode: z.string().default("normal"),
  generation: z.number().default(0),
  operationId: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
}).loose();

export const PlatformServiceSchema = z.object({
  id: z.string().default("unknown"),
  name: z.string().default("Service"),
  status: z.string().default("unknown"),
  detail: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
}).loose();

export const PlatformAutoUpdateScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  time: z.string().default("05:00"),
  timezone: z.string().default("Asia/Shanghai"),
  nextCheckAt: z.string().nullable().default(null),
  lastCheckedAt: z.string().nullable().default(null),
  lastResult: z.string().nullable().default(null),
}).loose();

export const PlatformStatusSchema = z.object({
  canManage: z.boolean().default(false),
  driver: z.string().default("systemd_release"),
  currentRelease: PlatformReleaseSchema.nullable().default(null),
  latestRelease: PlatformReleaseSchema.nullable().default(null),
  updateAvailable: z.boolean().default(false),
  autoUpdateStable: z.boolean().default(false),
  autoUpdateSchedule: PlatformAutoUpdateScheduleSchema.default({
    enabled: false,
    time: "05:00",
    timezone: "Asia/Shanghai",
    nextCheckAt: null,
    lastCheckedAt: null,
    lastResult: null,
  }),
  updaterStatus: z.string().default("offline"),
  updaterHeartbeatAt: z.string().nullable().default(null),
  services: z.array(PlatformServiceSchema).default([]),
  activeOperation: PlatformOperationSchema.nullable().default(null),
  lastOperation: PlatformOperationSchema.nullable().default(null),
  maintenance: PlatformMaintenanceSchema.default({
    mode: "normal",
    generation: 0,
    operationId: null,
    startedAt: null,
    expiresAt: null,
    reason: null,
  }),
  recentReleases: z.array(PlatformReleaseSchema).default([]),
}).loose();

export const PlatformOperationResponseSchema = z.object({
  operation: PlatformOperationSchema,
}).loose();

export const PlatformSettingsResponseSchema = z.object({
  state: z.object({
    autoUpdateStable: z.boolean().default(false),
    autoUpdate: PlatformAutoUpdateScheduleSchema,
  }).loose(),
}).loose();

export type PlatformRelease = z.infer<typeof PlatformReleaseSchema>;
export type PlatformOperation = z.infer<typeof PlatformOperationSchema>;
export type PlatformDrainProgress = z.infer<typeof PlatformDrainProgressSchema>;
export type PlatformMaintenance = z.infer<typeof PlatformMaintenanceSchema>;
export type PlatformService = z.infer<typeof PlatformServiceSchema>;
export type PlatformAutoUpdateSchedule = z.infer<typeof PlatformAutoUpdateScheduleSchema>;
export type PlatformStatus = z.infer<typeof PlatformStatusSchema>;

export const EMPTY_PLATFORM_STATUS: PlatformStatus = {
  canManage: false,
  driver: "systemd_release",
  currentRelease: null,
  latestRelease: null,
  updateAvailable: false,
  autoUpdateStable: false,
  autoUpdateSchedule: {
    enabled: false,
    time: "05:00",
    timezone: "Asia/Shanghai",
    nextCheckAt: null,
    lastCheckedAt: null,
    lastResult: null,
  },
  updaterStatus: "offline",
  updaterHeartbeatAt: null,
  services: [],
  activeOperation: null,
  lastOperation: null,
  maintenance: {
    mode: "normal",
    generation: 0,
    operationId: null,
    startedAt: null,
    expiresAt: null,
    reason: null,
  },
  recentReleases: [],
};
