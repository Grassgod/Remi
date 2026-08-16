export const RUNTIME_REQUEST_TABLES = [
  "multiremi_runtime_model_list_requests",
  "multiremi_runtime_update_requests",
  "multiremi_runtime_local_skill_list_requests",
  "multiremi_runtime_local_skill_import_requests",
  "multiremi_runtime_directory_scan_requests",
] as const;

export const RUNTIME_AUXILIARY_TABLES = [
  "multiremi_agent_plugin_runtime_states",
  "multiremi_runtime_models",
  ...RUNTIME_REQUEST_TABLES,
] as const;
