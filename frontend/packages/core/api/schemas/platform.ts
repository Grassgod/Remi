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

export const PlatformOperationSchema = z.object({
  id: z.string().default(""),
  kind: z.string().default("check_updates"),
  status: z.string().default("queued"),
  driver: z.string().default("systemd_release"),
  targetVersion: z.string().nullable().default(null),
  targetRef: z.string().nullable().default(null),
  targetManifest: z.record(z.string(), z.unknown()).default({}),
  progress: z.record(z.string(), z.unknown()).default({}),
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

export const PlatformServiceSchema = z.object({
  id: z.string().default("unknown"),
  name: z.string().default("Service"),
  status: z.string().default("unknown"),
  detail: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
}).loose();

export const PlatformStatusSchema = z.object({
  canManage: z.boolean().default(false),
  driver: z.string().default("systemd_release"),
  currentRelease: PlatformReleaseSchema.nullable().default(null),
  latestRelease: PlatformReleaseSchema.nullable().default(null),
  updateAvailable: z.boolean().default(false),
  autoUpdateStable: z.boolean().default(false),
  updaterStatus: z.string().default("offline"),
  updaterHeartbeatAt: z.string().nullable().default(null),
  services: z.array(PlatformServiceSchema).default([]),
  activeOperation: PlatformOperationSchema.nullable().default(null),
  recentReleases: z.array(PlatformReleaseSchema).default([]),
}).loose();

export const PlatformOperationResponseSchema = z.object({
  operation: PlatformOperationSchema,
}).loose();

export const PlatformSettingsResponseSchema = z.object({
  state: z.object({ autoUpdateStable: z.boolean().default(false) }).loose(),
}).loose();

export type PlatformRelease = z.infer<typeof PlatformReleaseSchema>;
export type PlatformOperation = z.infer<typeof PlatformOperationSchema>;
export type PlatformService = z.infer<typeof PlatformServiceSchema>;
export type PlatformStatus = z.infer<typeof PlatformStatusSchema>;

export const EMPTY_PLATFORM_STATUS: PlatformStatus = {
  canManage: false,
  driver: "systemd_release",
  currentRelease: null,
  latestRelease: null,
  updateAvailable: false,
  autoUpdateStable: false,
  updaterStatus: "offline",
  updaterHeartbeatAt: null,
  services: [],
  activeOperation: null,
  recentReleases: [],
};
