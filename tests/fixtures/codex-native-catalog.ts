/** Complete native model fixture; overrides may deliberately violate the loader contract. */
export function codexNativeModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "native-model", display_name: "Native model", shell_type: "shell_command", visibility: "list",
    supported_in_api: true, priority: 1, support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [],
    supported_reasoning_levels: [],
    model_messages: { instructions_template: "Native fixture instructions" },
    ...overrides,
  };
}
