export const RUNTIME_REQUEST_TABLES = [
  "multiremi_runtime_model_list_requests",
  "multiremi_runtime_update_requests",
  "multiremi_runtime_local_skill_list_requests",
  "multiremi_runtime_local_skill_import_requests",
  "multiremi_runtime_directory_scan_requests",
  "multiremi_runtime_command_requests",
  "multiremi_bot_menu_publish_requests",
] as const;

export const RUNTIME_AUXILIARY_TABLES = [
  "multiremi_agent_plugin_runtime_states",
  "multiremi_runtime_provision_states",
  "multiremi_runtime_models",
  // A retired Runtime's reported Feishu connector state must go with it;
  // leaving the row behind would make the workspace look permanently
  // `degraded` because a machine that no longer exists still claims the bot.
  "multiremi_feishu_bot_runtime_states",
  ...RUNTIME_REQUEST_TABLES,
] as const;
