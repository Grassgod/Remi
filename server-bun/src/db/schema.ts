import { pgTable, text, timestamp, unique, uuid, jsonb, integer, index, foreignKey, check, doublePrecision, date, varchar, uniqueIndex, type AnyPgColumn, boolean, bigint, inet, smallint, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { customType } from "drizzle-orm/pg-core"
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });



export const schemaMigrations = pgTable("schema_migrations", {
	version: text().primaryKey().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const workspace = pgTable("workspace", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	description: text(),
	settings: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	context: text(),
	repos: jsonb().default([]).notNull(),
	issuePrefix: text("issue_prefix").default('').notNull(),
	issueCounter: integer("issue_counter").default(0).notNull(),
	avatarUrl: text("avatar_url"),
}, (table) => [
	unique("workspace_slug_key").on(table.slug),
]);

export const agent = pgTable("agent", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	avatarUrl: text("avatar_url"),
	runtimeMode: text("runtime_mode").notNull(),
	runtimeConfig: jsonb("runtime_config").default({}).notNull(),
	visibility: text().default('private').notNull(),
	status: text().default('offline').notNull(),
	maxConcurrentTasks: integer("max_concurrent_tasks").default(6).notNull(),
	ownerId: uuid("owner_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	description: text().default('').notNull(),
	runtimeId: uuid("runtime_id").notNull(),
	instructions: text().default('').notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	archivedBy: uuid("archived_by"),
	customEnv: jsonb("custom_env").default({}).notNull(),
	customArgs: jsonb("custom_args").default([]).notNull(),
	mcpConfig: jsonb("mcp_config"),
	model: text(),
	thinkingLevel: text("thinking_level"),
}, (table) => [
	index("idx_agent_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("agent_workspace_name_unique").on(table.workspaceId, table.name),
]);

export const member = pgTable("member", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_member_user_workspace").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.workspaceId.asc().nullsLast().op("uuid_ops")),
	index("idx_member_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("member_workspace_id_user_id_key").on(table.workspaceId, table.userId),
]);

export const issue = pgTable("issue", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	title: text().notNull(),
	description: text(),
	status: text().default('backlog').notNull(),
	priority: text().default('none').notNull(),
	assigneeType: text("assignee_type"),
	assigneeId: uuid("assignee_id"),
	creatorType: text("creator_type").notNull(),
	creatorId: uuid("creator_id").notNull(),
	parentIssueId: uuid("parent_issue_id"),
	acceptanceCriteria: jsonb("acceptance_criteria").default([]).notNull(),
	contextRefs: jsonb("context_refs").default([]).notNull(),
	position: doublePrecision().default(0).notNull(),
	dueDate: date("due_date"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	number: integer().default(0).notNull(),
	projectId: uuid("project_id"),
	originType: text("origin_type"),
	originId: uuid("origin_id"),
	firstExecutedAt: timestamp("first_executed_at", { withTimezone: true, mode: 'string' }),
	startDate: date("start_date"),
	metadata: jsonb().default({}).notNull(),
}, (table) => [
	index("idx_issue_assignee").using("btree", table.assigneeType.asc().nullsLast().op("text_ops"), table.assigneeId.asc().nullsLast().op("text_ops")),
	index("idx_issue_first_executed_at").using("btree", table.workspaceId.asc().nullsLast().op("timestamptz_ops"), table.firstExecutedAt.asc().nullsLast().op("uuid_ops")).where(sql`(first_executed_at IS NOT NULL)`),
	index("idx_issue_metadata_gin").using("gin", table.metadata.asc().nullsLast().op("jsonb_path_ops")),
	index("idx_issue_origin").using("btree", table.originType.asc().nullsLast().op("text_ops"), table.originId.asc().nullsLast().op("uuid_ops")).where(sql`(origin_type IS NOT NULL)`),
	index("idx_issue_parent").using("btree", table.parentIssueId.asc().nullsLast().op("uuid_ops")),
	index("idx_issue_project").using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	index("idx_issue_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_issue_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	index("idx_issue_workspace_number").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.number.asc().nullsLast().op("uuid_ops")),
	unique("uq_issue_workspace_number").on(table.workspaceId, table.number),
]);

export const user = pgTable("user", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	avatarUrl: text("avatar_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	onboardedAt: timestamp("onboarded_at", { withTimezone: true, mode: 'string' }),
	onboardingQuestionnaire: jsonb("onboarding_questionnaire").default({}).notNull(),
	cloudWaitlistEmail: varchar("cloud_waitlist_email", { length: 254 }),
	cloudWaitlistReason: text("cloud_waitlist_reason"),
	starterContentState: text("starter_content_state"),
	language: varchar({ length: 20 }).default(sql`NULL`),
	profileDescription: text("profile_description").default('').notNull(),
	timezone: text(),
}, (table) => [
	unique("user_email_key").on(table.email),
]);

export const issueLabel = pgTable("issue_label", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	color: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("issue_label_workspace_name_lower_idx").using("btree", sql`workspace_id`, sql`lower(name)`),
]);

export const issueDependency = pgTable("issue_dependency", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	issueId: uuid("issue_id").notNull(),
	dependsOnIssueId: uuid("depends_on_issue_id").notNull(),
	type: text().notNull(),
}, (table) => [
]);

export const agentTaskQueue = pgTable("agent_task_queue", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	agentId: uuid("agent_id").notNull(),
	issueId: uuid("issue_id"),
	status: text().default('queued').notNull(),
	priority: integer().default(0).notNull(),
	dispatchedAt: timestamp("dispatched_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	result: jsonb(),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	context: jsonb(),
	runtimeId: uuid("runtime_id").notNull(),
	sessionId: text("session_id"),
	workDir: text("work_dir"),
	triggerCommentId: uuid("trigger_comment_id"),
	chatSessionId: uuid("chat_session_id"),
	autopilotRunId: uuid("autopilot_run_id"),
	attempt: integer().default(1).notNull(),
	maxAttempts: integer("max_attempts").default(2).notNull(),
	parentTaskId: uuid("parent_task_id"),
	failureReason: text("failure_reason"),
	triggerSummary: text("trigger_summary"),
	forceFreshSession: boolean("force_fresh_session").default(false).notNull(),
	isLeaderTask: boolean("is_leader_task").default(false).notNull(),
	waitReason: text("wait_reason"),
}, (table) => [
	index("idx_agent_task_queue_agent").using("btree", table.agentId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_agent_task_queue_chat_pending").using("btree", table.chatSessionId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`((chat_session_id IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'dispatched'::text, 'running'::text])))`),
	index("idx_agent_task_queue_claim_candidates").using("btree", table.runtimeId.asc().nullsLast().op("timestamptz_ops"), table.priority.desc().nullsFirst().op("uuid_ops"), table.createdAt.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'queued'::text)`),
	index("idx_agent_task_queue_issue_id").using("btree", table.issueId.asc().nullsLast().op("uuid_ops")),
	index("idx_agent_task_queue_parent").using("btree", table.parentTaskId.asc().nullsLast().op("uuid_ops")),
	index("idx_agent_task_queue_pending").using("btree", table.agentId.asc().nullsLast().op("int4_ops"), table.priority.desc().nullsFirst().op("int4_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['queued'::text, 'dispatched'::text]))`),
	index("idx_agent_task_queue_queued_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'queued'::text)`),
	index("idx_agent_task_queue_running_started_at").using("btree", table.startedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'running'::text)`),
	index("idx_agent_task_queue_runtime_pending").using("btree", table.runtimeId.asc().nullsLast().op("timestamptz_ops"), table.priority.desc().nullsFirst().op("uuid_ops"), table.createdAt.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['queued'::text, 'dispatched'::text]))`),
	uniqueIndex("idx_one_pending_task_per_issue_agent").using("btree", table.issueId.asc().nullsLast().op("uuid_ops"), table.agentId.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['queued'::text, 'dispatched'::text]))`),
]);

export const daemonConnection = pgTable("daemon_connection", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	agentId: uuid("agent_id").notNull(),
	daemonId: text("daemon_id").notNull(),
	status: text().default('disconnected').notNull(),
	lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true, mode: 'string' }),
	runtimeInfo: jsonb("runtime_info").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("uq_daemon_agent").on(table.agentId, table.daemonId),
]);

export const inboxItem = pgTable("inbox_item", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	recipientType: text("recipient_type").notNull(),
	recipientId: uuid("recipient_id").notNull(),
	type: text().notNull(),
	severity: text().default('info').notNull(),
	issueId: uuid("issue_id"),
	title: text().notNull(),
	body: text(),
	read: boolean().default(false).notNull(),
	archived: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	actorType: text("actor_type"),
	actorId: uuid("actor_id"),
	details: jsonb().default({}),
}, (table) => [
	index("idx_inbox_recipient").using("btree", table.recipientType.asc().nullsLast().op("text_ops"), table.recipientId.asc().nullsLast().op("uuid_ops"), table.read.asc().nullsLast().op("uuid_ops")),
]);

export const activityLog = pgTable("activity_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	issueId: uuid("issue_id"),
	actorType: text("actor_type"),
	actorId: uuid("actor_id"),
	action: text().notNull(),
	details: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_activity_log_issue_keyset").using("btree", table.issueId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops"), table.id.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_activity_log_squad_no_action_task").using("btree", sql`issue_id`, sql`actor_id`, sql`((details ->> 'task_id'::text))`).where(sql`((actor_type = 'agent'::text) AND (action = 'squad_leader_evaluated'::text) AND ((details ->> 'outcome'::text) = 'no_action'::text))`),
]);

export const skill = pgTable("skill", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	description: text().default('').notNull(),
	content: text().default('').notNull(),
	config: jsonb().default({}).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_skill_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("skill_workspace_id_name_key").on(table.workspaceId, table.name),
]);

export const agentRuntime = pgTable("agent_runtime", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	daemonId: text("daemon_id"),
	name: text().notNull(),
	runtimeMode: text("runtime_mode").notNull(),
	provider: text().notNull(),
	status: text().default('offline').notNull(),
	deviceInfo: text("device_info").default('').notNull(),
	metadata: jsonb().default({}).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	ownerId: uuid("owner_id"),
	legacyDaemonId: text("legacy_daemon_id"),
	visibility: text().default('private').notNull(),
}, (table) => [
	index("idx_agent_runtime_last_seen_at").using("btree", table.lastSeenAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_agent_runtime_status").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_agent_runtime_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("agent_runtime_workspace_id_daemon_id_provider_key").on(table.workspaceId, table.daemonId, table.provider),
]);

export const skillFile = pgTable("skill_file", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	skillId: uuid("skill_id").notNull(),
	path: text().notNull(),
	content: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_skill_file_skill").using("btree", table.skillId.asc().nullsLast().op("uuid_ops")),
	unique("skill_file_skill_id_path_key").on(table.skillId, table.path),
]);

export const verificationCode = pgTable("verification_code", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	code: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	used: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	attempts: integer().default(0).notNull(),
}, (table) => [
	index("idx_verification_code_email").using("btree", table.email.asc().nullsLast().op("text_ops"), table.used.asc().nullsLast().op("bool_ops"), table.expiresAt.asc().nullsLast().op("bool_ops")),
]);

export const personalAccessToken = pgTable("personal_access_token", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	name: text().notNull(),
	tokenHash: text("token_hash").notNull(),
	tokenPrefix: text("token_prefix").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	revoked: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_pat_token_hash").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
	index("idx_pat_user").using("btree", table.userId.asc().nullsLast().op("bool_ops"), table.revoked.asc().nullsLast().op("bool_ops")),
]);

export const commentReaction = pgTable("comment_reaction", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	commentId: uuid("comment_id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	actorType: text("actor_type").notNull(),
	actorId: uuid("actor_id").notNull(),
	emoji: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_comment_reaction_comment_id").using("btree", table.commentId.asc().nullsLast().op("uuid_ops")),
	unique("comment_reaction_comment_id_actor_type_actor_id_emoji_key").on(table.commentId, table.actorType, table.actorId, table.emoji),
]);

export const issueReaction = pgTable("issue_reaction", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	issueId: uuid("issue_id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	actorType: text("actor_type").notNull(),
	actorId: uuid("actor_id").notNull(),
	emoji: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_issue_reaction_issue_id").using("btree", table.issueId.asc().nullsLast().op("uuid_ops")),
	unique("issue_reaction_issue_id_actor_type_actor_id_emoji_key").on(table.issueId, table.actorType, table.actorId, table.emoji),
]);

export const taskMessage = pgTable("task_message", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	taskId: uuid("task_id").notNull(),
	seq: integer().notNull(),
	type: text().notNull(),
	tool: text(),
	content: text(),
	input: jsonb(),
	output: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_task_message_task_id_seq").using("btree", table.taskId.asc().nullsLast().op("int4_ops"), table.seq.asc().nullsLast().op("int4_ops")),
]);

export const attachment = pgTable("attachment", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	issueId: uuid("issue_id"),
	commentId: uuid("comment_id"),
	uploaderType: text("uploader_type").notNull(),
	uploaderId: uuid("uploader_id").notNull(),
	filename: text().notNull(),
	url: text().notNull(),
	contentType: text("content_type").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	chatSessionId: uuid("chat_session_id"),
	chatMessageId: uuid("chat_message_id"),
}, (table) => [
	index("idx_attachment_chat_message").using("btree", table.chatMessageId.asc().nullsLast().op("uuid_ops")).where(sql`(chat_message_id IS NOT NULL)`),
	index("idx_attachment_chat_session").using("btree", table.chatSessionId.asc().nullsLast().op("uuid_ops")).where(sql`(chat_session_id IS NOT NULL)`),
	index("idx_attachment_comment").using("btree", table.commentId.asc().nullsLast().op("uuid_ops")).where(sql`(comment_id IS NOT NULL)`),
	index("idx_attachment_issue").using("btree", table.issueId.asc().nullsLast().op("uuid_ops")).where(sql`(issue_id IS NOT NULL)`),
	index("idx_attachment_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
]);

export const daemonToken = pgTable("daemon_token", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tokenHash: text("token_hash").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	daemonId: text("daemon_id").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_daemon_token_hash").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
	index("idx_daemon_token_workspace_daemon").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.daemonId.asc().nullsLast().op("text_ops")),
]);

export const project = pgTable("project", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	title: text().notNull(),
	description: text(),
	icon: text(),
	status: text().default('planned').notNull(),
	leadType: text("lead_type"),
	leadId: uuid("lead_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	priority: text().default('none').notNull(),
}, (table) => [
	index("idx_project_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
]);

export const chatMessage = pgTable("chat_message", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	chatSessionId: uuid("chat_session_id").notNull(),
	role: text().notNull(),
	content: text().notNull(),
	taskId: uuid("task_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	failureReason: text("failure_reason"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	elapsedMs: bigint("elapsed_ms", { mode: "number" }),
}, (table) => [
	index("idx_chat_message_session").using("btree", table.chatSessionId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
]);

export const pinnedItem = pgTable("pinned_item", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	itemType: text("item_type").notNull(),
	itemId: uuid("item_id").notNull(),
	position: doublePrecision().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_pinned_item_user_ws").using("btree", table.workspaceId.asc().nullsLast().op("float8_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.position.asc().nullsLast().op("uuid_ops")),
	unique("pinned_item_workspace_id_user_id_item_type_item_id_key").on(table.workspaceId, table.userId, table.itemType, table.itemId),
]);

export const taskUsage = pgTable("task_usage", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	taskId: uuid("task_id").notNull(),
	provider: text().default('').notNull(),
	model: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_task_usage_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_task_usage_created_at_legacy").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(updated_at IS NULL)`),
	index("idx_task_usage_task_id").using("btree", table.taskId.asc().nullsLast().op("uuid_ops")),
	index("idx_task_usage_updated_at").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	unique("task_usage_task_id_provider_model_key").on(table.taskId, table.provider, table.model),
]);

export const chatSession = pgTable("chat_session", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	agentId: uuid("agent_id").notNull(),
	creatorId: uuid("creator_id").notNull(),
	title: text().default('').notNull(),
	sessionId: text("session_id"),
	workDir: text("work_dir"),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	unreadSince: timestamp("unread_since", { withTimezone: true, mode: 'string' }),
	runtimeId: uuid("runtime_id"),
}, (table) => [
	index("idx_chat_session_creator").using("btree", table.creatorId.asc().nullsLast().op("uuid_ops"), table.workspaceId.asc().nullsLast().op("uuid_ops")),
	index("idx_chat_session_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
]);

export const workspaceInvitation = pgTable("workspace_invitation", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	inviterId: uuid("inviter_id").notNull(),
	inviteeEmail: text("invitee_email").notNull(),
	inviteeUserId: uuid("invitee_user_id"),
	role: text().notNull(),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).default(sql`(now() + '7 days'::interval)`).notNull(),
}, (table) => [
	index("idx_invitation_invitee_email").using("btree", table.inviteeEmail.asc().nullsLast().op("text_ops")).where(sql`(status = 'pending'::text)`),
	index("idx_invitation_invitee_user").using("btree", table.inviteeUserId.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'pending'::text)`),
	uniqueIndex("idx_invitation_unique_pending").using("btree", table.workspaceId.asc().nullsLast().op("text_ops"), table.inviteeEmail.asc().nullsLast().op("text_ops")).where(sql`(status = 'pending'::text)`),
]);

export const notificationPreference = pgTable("notification_preference", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	preferences: jsonb().default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("notification_preference_workspace_id_user_id_key").on(table.workspaceId, table.userId),
]);

export const feedback = pgTable("feedback", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	workspaceId: uuid("workspace_id"),
	message: text().notNull(),
	metadata: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_feedback_user_created").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
]);

export const autopilot = pgTable("autopilot", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	title: text().notNull(),
	description: text(),
	assigneeId: uuid("assignee_id").notNull(),
	status: text().default('active').notNull(),
	executionMode: text("execution_mode").default('create_issue').notNull(),
	issueTitleTemplate: text("issue_title_template"),
	createdByType: text("created_by_type").notNull(),
	createdById: uuid("created_by_id").notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	assigneeType: text("assignee_type").default('agent').notNull(),
	projectId: uuid("project_id"),
}, (table) => [
	index("idx_autopilot_assignee").using("btree", table.assigneeId.asc().nullsLast().op("uuid_ops")),
	index("idx_autopilot_assignee_type_id").using("btree", table.assigneeType.asc().nullsLast().op("uuid_ops"), table.assigneeId.asc().nullsLast().op("text_ops")),
	index("idx_autopilot_project").using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	index("idx_autopilot_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
]);

export const autopilotRun = pgTable("autopilot_run", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	autopilotId: uuid("autopilot_id").notNull(),
	triggerId: uuid("trigger_id"),
	source: text().notNull(),
	status: text().default('pending').notNull(),
	issueId: uuid("issue_id"),
	taskId: uuid("task_id"),
	triggeredAt: timestamp("triggered_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	failureReason: text("failure_reason"),
	triggerPayload: jsonb("trigger_payload"),
	result: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	squadId: uuid("squad_id"),
}, (table) => [
	index("idx_autopilot_run_autopilot").using("btree", table.autopilotId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_autopilot_run_issue").using("btree", table.issueId.asc().nullsLast().op("uuid_ops")).where(sql`(issue_id IS NOT NULL)`),
	index("idx_autopilot_run_squad_id").using("btree", table.squadId.asc().nullsLast().op("uuid_ops")).where(sql`(squad_id IS NOT NULL)`),
	index("idx_autopilot_run_status").using("btree", table.autopilotId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['issue_created'::text, 'running'::text]))`),
]);

export const projectResource = pgTable("project_resource", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	resourceType: text("resource_type").notNull(),
	resourceRef: jsonb("resource_ref").notNull(),
	label: text(),
	position: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdBy: uuid("created_by"),
}, (table) => [
	index("idx_project_resource_project").using("btree", table.projectId.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("uuid_ops")),
	index("idx_project_resource_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("project_resource_project_id_resource_type_resource_ref_key").on(table.projectId, table.resourceType, table.resourceRef),
]);

export const comment = pgTable("comment", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	issueId: uuid("issue_id").notNull(),
	authorType: text("author_type").notNull(),
	authorId: uuid("author_id").notNull(),
	content: text().notNull(),
	type: text().default('comment').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	parentId: uuid("parent_id"),
	workspaceId: uuid("workspace_id").notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	resolvedByType: text("resolved_by_type"),
	resolvedById: uuid("resolved_by_id"),
}, (table) => [
	index("comment_issue_resolved_at_idx").using("btree", table.issueId.asc().nullsLast().op("timestamptz_ops"), table.resolvedAt.asc().nullsLast().op("uuid_ops")),
	index("idx_comment_issue_keyset").using("btree", table.issueId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops"), table.id.desc().nullsFirst().op("timestamptz_ops")),
]);

export const githubInstallation = pgTable("github_installation", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	installationId: bigint("installation_id", { mode: "number" }).notNull(),
	accountLogin: text("account_login").notNull(),
	accountType: text("account_type").default('User').notNull(),
	accountAvatarUrl: text("account_avatar_url"),
	connectedById: uuid("connected_by_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_github_installation_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("github_installation_installation_id_key").on(table.installationId),
]);

export const githubPullRequest = pgTable("github_pull_request", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	installationId: bigint("installation_id", { mode: "number" }).notNull(),
	repoOwner: text("repo_owner").notNull(),
	repoName: text("repo_name").notNull(),
	prNumber: integer("pr_number").notNull(),
	title: text().notNull(),
	state: text().notNull(),
	htmlUrl: text("html_url").notNull(),
	branch: text(),
	authorLogin: text("author_login"),
	authorAvatarUrl: text("author_avatar_url"),
	mergedAt: timestamp("merged_at", { withTimezone: true, mode: 'string' }),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	prCreatedAt: timestamp("pr_created_at", { withTimezone: true, mode: 'string' }).notNull(),
	prUpdatedAt: timestamp("pr_updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	headSha: text("head_sha").default('').notNull(),
	mergeableState: text("mergeable_state"),
	additions: integer().default(0).notNull(),
	deletions: integer().default(0).notNull(),
	changedFiles: integer("changed_files").default(0).notNull(),
}, (table) => [
	index("idx_github_pull_request_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("github_pull_request_workspace_id_repo_owner_repo_name_pr_nu_key").on(table.workspaceId, table.repoOwner, table.repoName, table.prNumber),
]);

export const squadMember = pgTable("squad_member", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	squadId: uuid("squad_id").notNull(),
	memberType: text("member_type").notNull(),
	memberId: uuid("member_id").notNull(),
	role: text().default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_squad_member_entity").using("btree", table.memberType.asc().nullsLast().op("uuid_ops"), table.memberId.asc().nullsLast().op("uuid_ops")),
	index("idx_squad_member_squad").using("btree", table.squadId.asc().nullsLast().op("uuid_ops")),
	unique("squad_member_squad_id_member_type_member_id_key").on(table.squadId, table.memberType, table.memberId),
]);

export const autopilotTrigger = pgTable("autopilot_trigger", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	autopilotId: uuid("autopilot_id").notNull(),
	kind: text().notNull(),
	enabled: boolean().default(true).notNull(),
	cronExpression: text("cron_expression"),
	timezone: text().default('UTC'),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }),
	webhookToken: text("webhook_token"),
	label: text(),
	lastFiredAt: timestamp("last_fired_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	provider: text().default('generic').notNull(),
	signingSecret: text("signing_secret"),
	eventFilters: jsonb("event_filters"),
}, (table) => [
	index("idx_autopilot_trigger_autopilot").using("btree", table.autopilotId.asc().nullsLast().op("uuid_ops")),
	index("idx_autopilot_trigger_next_run").using("btree", table.nextRunAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((enabled = true) AND (kind = 'schedule'::text))`),
	uniqueIndex("idx_autopilot_trigger_webhook_token").using("btree", table.webhookToken.asc().nullsLast().op("text_ops")).where(sql`((kind = 'webhook'::text) AND (webhook_token IS NOT NULL))`),
]);

export const squad = pgTable("squad", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	name: text().notNull(),
	description: text().default('').notNull(),
	leaderId: uuid("leader_id").notNull(),
	creatorId: uuid("creator_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	archivedBy: uuid("archived_by"),
	avatarUrl: text("avatar_url"),
	instructions: text().default('').notNull(),
}, (table) => [
	index("idx_squad_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
]);

export const webhookDelivery = pgTable("webhook_delivery", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	autopilotId: uuid("autopilot_id").notNull(),
	triggerId: uuid("trigger_id").notNull(),
	provider: text().notNull(),
	event: text().default('webhook.received').notNull(),
	dedupeKey: text("dedupe_key"),
	dedupeSource: text("dedupe_source"),
	signatureStatus: text("signature_status").default('not_required').notNull(),
	status: text().default('queued').notNull(),
	attemptCount: integer("attempt_count").default(1).notNull(),
	selectedHeaders: jsonb("selected_headers").default({}).notNull(),
	contentType: text("content_type"),
	// TODO: failed to parse database type 'bytea'
	rawBody: bytea("raw_body"),
	responseStatus: integer("response_status"),
	responseBody: text("response_body"),
	autopilotRunId: uuid("autopilot_run_id"),
	replayedFromDeliveryId: uuid("replayed_from_delivery_id"),
	error: text(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_webhook_delivery_autopilot").using("btree", table.autopilotId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("idx_webhook_delivery_dedupe").using("btree", table.triggerId.asc().nullsLast().op("uuid_ops"), table.dedupeKey.asc().nullsLast().op("text_ops")).where(sql`((dedupe_key IS NOT NULL) AND (status <> ALL (ARRAY['rejected'::text, 'failed'::text])))`),
	index("idx_webhook_delivery_run").using("btree", table.autopilotRunId.asc().nullsLast().op("uuid_ops")).where(sql`(autopilot_run_id IS NOT NULL)`),
]);

export const contactSalesInquiry = pgTable("contact_sales_inquiry", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	firstName: text("first_name").notNull(),
	lastName: text("last_name").notNull(),
	businessEmail: text("business_email").notNull(),
	companyName: text("company_name").notNull(),
	companySize: text("company_size").notNull(),
	countryRegion: text("country_region").notNull(),
	useCase: text("use_case").notNull(),
	goals: text().default('').notNull(),
	consentOutreach: boolean("consent_outreach").default(false).notNull(),
	consentUpdates: boolean("consent_updates").default(false).notNull(),
	submitterIp: inet("submitter_ip"),
	userAgent: text("user_agent").default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_contact_sales_inquiry_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_contact_sales_inquiry_email_created").using("btree", table.businessEmail.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
]);

export const taskUsageHourly = pgTable("task_usage_hourly", {
	bucketHour: timestamp("bucket_hour", { withTimezone: true, mode: 'string' }).notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	runtimeId: uuid("runtime_id").notNull(),
	agentId: uuid("agent_id").notNull(),
	projectId: uuid("project_id"),
	provider: text().notNull(),
	model: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taskCount: bigint("task_count", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	eventCount: bigint("event_count", { mode: "number" }).default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_task_usage_hourly_runtime_time").using("btree", table.runtimeId.asc().nullsLast().op("uuid_ops"), table.bucketHour.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_task_usage_hourly_workspace_agent_time").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.agentId.asc().nullsLast().op("timestamptz_ops"), table.bucketHour.desc().nullsFirst().op("uuid_ops")),
	index("idx_task_usage_hourly_workspace_project_time").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.projectId.asc().nullsLast().op("uuid_ops"), table.bucketHour.desc().nullsFirst().op("uuid_ops")).where(sql`(project_id IS NOT NULL)`),
	index("idx_task_usage_hourly_workspace_time").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.bucketHour.desc().nullsFirst().op("uuid_ops")),
	unique("uq_task_usage_hourly_key").on(table.bucketHour, table.workspaceId, table.runtimeId, table.agentId, table.projectId, table.provider, table.model),
]);

export const taskUsageHourlyRollupState = pgTable("task_usage_hourly_rollup_state", {
	id: smallint().default(1).primaryKey().notNull(),
	watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: 'string' }).default('1970-01-01 00:00:00+00').notNull(),
	lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true, mode: 'string' }),
	lastRunFinishedAt: timestamp("last_run_finished_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastRunRows: bigint("last_run_rows", { mode: "number" }).default(0).notNull(),
	lastError: text("last_error"),
}, (table) => [
]);

export const taskUsageHourlyDirty = pgTable("task_usage_hourly_dirty", {
	bucketHour: timestamp("bucket_hour", { withTimezone: true, mode: 'string' }).notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	runtimeId: uuid("runtime_id").notNull(),
	agentId: uuid("agent_id").notNull(),
	projectId: uuid("project_id"),
	provider: text().notNull(),
	model: text().notNull(),
	enqueuedAt: timestamp("enqueued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_task_usage_hourly_dirty_enqueued_at").using("btree", table.enqueuedAt.asc().nullsLast().op("timestamptz_ops")),
	unique("uq_task_usage_hourly_dirty_key").on(table.bucketHour, table.workspaceId, table.runtimeId, table.agentId, table.projectId, table.provider, table.model),
]);

export const taskToken = pgTable("task_token", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tokenHash: text("token_hash").notNull(),
	taskId: uuid("task_id").notNull(),
	agentId: uuid("agent_id").notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	userId: uuid("user_id").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_task_token_hash").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
	index("idx_task_token_task").using("btree", table.taskId.asc().nullsLast().op("uuid_ops")),
]);

export const larkUserBinding = pgTable("lark_user_binding", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	multimiraUserId: uuid("multimira_user_id").notNull(),
	installationId: uuid("installation_id").notNull(),
	larkOpenId: text("lark_open_id").notNull(),
	unionId: text("union_id"),
	boundAt: timestamp("bound_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_lark_user_binding_user").using("btree", table.multimiraUserId.asc().nullsLast().op("uuid_ops"), table.workspaceId.asc().nullsLast().op("uuid_ops")),
	index("idx_lark_user_binding_workspace_open").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops"), table.larkOpenId.asc().nullsLast().op("uuid_ops")),
	unique("lark_user_binding_installation_id_lark_open_id_key").on(table.installationId, table.larkOpenId),
]);

export const larkInstallation = pgTable("lark_installation", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	agentId: uuid("agent_id").notNull(),
	appId: text("app_id").notNull(),
	// TODO: failed to parse database type 'bytea'
	appSecretEncrypted: bytea("app_secret_encrypted").notNull(),
	tenantKey: text("tenant_key"),
	botOpenId: text("bot_open_id").notNull(),
	installerUserId: uuid("installer_user_id").notNull(),
	status: text().default('active').notNull(),
	wsLeaseToken: text("ws_lease_token"),
	wsLeaseExpiresAt: timestamp("ws_lease_expires_at", { withTimezone: true, mode: 'string' }),
	installedAt: timestamp("installed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	botUnionId: text("bot_union_id"),
	region: text().default('feishu').notNull(),
}, (table) => [
	index("idx_lark_installation_agent").using("btree", table.agentId.asc().nullsLast().op("uuid_ops")),
	index("idx_lark_installation_lease").using("btree", table.wsLeaseExpiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'active'::text)`),
	index("idx_lark_installation_workspace").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	unique("lark_installation_id_workspace_id_key").on(table.id, table.workspaceId),
	unique("lark_installation_workspace_id_agent_id_key").on(table.workspaceId, table.agentId),
	unique("lark_installation_app_id_key").on(table.appId),
]);

export const larkChatSessionBinding = pgTable("lark_chat_session_binding", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	chatSessionId: uuid("chat_session_id").notNull(),
	installationId: uuid("installation_id").notNull(),
	larkChatId: text("lark_chat_id").notNull(),
	larkChatType: text("lark_chat_type").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_lark_chat_session_binding_session").using("btree", table.chatSessionId.asc().nullsLast().op("uuid_ops")),
	unique("lark_chat_session_binding_chat_session_id_key").on(table.chatSessionId),
	unique("lark_chat_session_binding_installation_id_lark_chat_id_key").on(table.installationId, table.larkChatId),
]);

export const larkInboundAudit = pgTable("lark_inbound_audit", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	installationId: uuid("installation_id"),
	larkChatId: text("lark_chat_id"),
	eventType: text("event_type").notNull(),
	larkEventId: text("lark_event_id"),
	larkMessageId: text("lark_message_id"),
	dropReason: text("drop_reason").notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_lark_inbound_audit_installation").using("btree", table.installationId.asc().nullsLast().op("timestamptz_ops"), table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_lark_inbound_audit_reason").using("btree", table.dropReason.asc().nullsLast().op("timestamptz_ops"), table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
]);

export const larkOutboundCardMessage = pgTable("lark_outbound_card_message", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	chatSessionId: uuid("chat_session_id").notNull(),
	taskId: uuid("task_id"),
	larkChatId: text("lark_chat_id").notNull(),
	larkCardMessageId: text("lark_card_message_id").notNull(),
	status: text().default('pending').notNull(),
	lastPatchedAt: timestamp("last_patched_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_lark_outbound_card_session").using("btree", table.chatSessionId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("idx_lark_outbound_card_task").using("btree", table.taskId.asc().nullsLast().op("uuid_ops")).where(sql`(task_id IS NOT NULL)`),
]);

export const larkBindingToken = pgTable("lark_binding_token", {
	tokenHash: text("token_hash").primaryKey().notNull(),
	workspaceId: uuid("workspace_id").notNull(),
	installationId: uuid("installation_id").notNull(),
	larkOpenId: text("lark_open_id").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_lark_binding_token_installation").using("btree", table.installationId.asc().nullsLast().op("timestamptz_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
]);

export const sysCronExecutions = pgTable("sys_cron_executions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	jobName: text("job_name").notNull(),
	scopeKind: text("scope_kind").default('global').notNull(),
	scopeId: text("scope_id").default('global').notNull(),
	planTime: timestamp("plan_time", { withTimezone: true, mode: 'string' }).notNull(),
	status: text().notNull(),
	attempt: integer().default(1).notNull(),
	maxAttempts: integer("max_attempts").default(3).notNull(),
	nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: 'string' }),
	runnerId: text("runner_id"),
	leaseToken: uuid("lease_token").defaultRandom().notNull(),
	heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: 'string' }),
	staleAfter: timestamp("stale_after", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	durationMs: integer("duration_ms"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rowsAffected: bigint("rows_affected", { mode: "number" }),
	result: jsonb().default({}).notNull(),
	errorCode: text("error_code"),
	errorMsg: text("error_msg"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_sys_cron_exec_failed_recent").using("btree", table.jobName.asc().nullsLast().op("text_ops"), table.planTime.desc().nullsFirst().op("text_ops")).where(sql`(status = 'FAILED'::text)`),
	index("idx_sys_cron_exec_finished").using("btree", table.finishedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['SUCCESS'::text, 'FAILED'::text]))`),
	index("idx_sys_cron_exec_job_plan").using("btree", table.jobName.asc().nullsLast().op("text_ops"), table.scopeKind.asc().nullsLast().op("text_ops"), table.scopeId.asc().nullsLast().op("text_ops"), table.planTime.desc().nullsFirst().op("text_ops")),
	index("idx_sys_cron_exec_running_stale").using("btree", table.staleAfter.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'RUNNING'::text)`),
	unique("uq_sys_cron_execution").on(table.jobName, table.scopeKind, table.scopeId, table.planTime),
]);

export const issueToLabel = pgTable("issue_to_label", {
	issueId: uuid("issue_id").notNull(),
	labelId: uuid("label_id").notNull(),
}, (table) => [
	primaryKey({ columns: [table.issueId, table.labelId], name: "issue_to_label_pkey"}),
]);

export const agentSkill = pgTable("agent_skill", {
	agentId: uuid("agent_id").notNull(),
	skillId: uuid("skill_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_agent_skill_agent").using("btree", table.agentId.asc().nullsLast().op("uuid_ops")),
	index("idx_agent_skill_skill").using("btree", table.skillId.asc().nullsLast().op("uuid_ops")),
	primaryKey({ columns: [table.agentId, table.skillId], name: "agent_skill_pkey"}),
]);

export const issueSubscriber = pgTable("issue_subscriber", {
	issueId: uuid("issue_id").notNull(),
	userType: text("user_type").notNull(),
	userId: uuid("user_id").notNull(),
	reason: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_issue_subscriber_user").using("btree", table.userType.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	primaryKey({ columns: [table.issueId, table.userType, table.userId], name: "issue_subscriber_pkey"}),
]);

export const larkInboundMessageDedup = pgTable("lark_inbound_message_dedup", {
	installationId: uuid("installation_id").notNull(),
	messageId: text("message_id").notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	claimToken: uuid("claim_token").defaultRandom().notNull(),
}, (table) => [
	index("idx_lark_inbound_dedup_received").using("btree", table.receivedAt.asc().nullsLast().op("timestamptz_ops")),
	primaryKey({ columns: [table.installationId, table.messageId], name: "lark_inbound_message_dedup_pkey"}),
]);

export const issuePullRequest = pgTable("issue_pull_request", {
	issueId: uuid("issue_id").notNull(),
	pullRequestId: uuid("pull_request_id").notNull(),
	linkedByType: text("linked_by_type"),
	linkedById: uuid("linked_by_id"),
	linkedAt: timestamp("linked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	closeIntent: boolean("close_intent").default(false).notNull(),
}, (table) => [
	index("idx_issue_pull_request_pr").using("btree", table.pullRequestId.asc().nullsLast().op("uuid_ops")),
	primaryKey({ columns: [table.issueId, table.pullRequestId], name: "issue_pull_request_pkey"}),
]);

export const githubPullRequestCheckSuite = pgTable("github_pull_request_check_suite", {
	prId: uuid("pr_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	suiteId: bigint("suite_id", { mode: "number" }).notNull(),
	headSha: text("head_sha").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	appId: bigint("app_id", { mode: "number" }).notNull(),
	conclusion: text(),
	status: text().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("idx_github_pr_check_suite_aggregate").using("btree", table.prId.asc().nullsLast().op("int8_ops"), table.headSha.asc().nullsLast().op("int8_ops"), table.appId.asc().nullsLast().op("int8_ops"), table.updatedAt.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.prId, table.suiteId], name: "github_pull_request_check_suite_pkey"}),
]);

// ── Inferred row types (used by the query layer) ────────────────────────────
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Workspace = typeof workspace.$inferSelect;
export type NewWorkspace = typeof workspace.$inferInsert;
export type Member = typeof member.$inferSelect;
export type Issue = typeof issue.$inferSelect;
export type NewIssue = typeof issue.$inferInsert;
export type Project = typeof project.$inferSelect;
export type Comment = typeof comment.$inferSelect;
export type Agent = typeof agent.$inferSelect;
