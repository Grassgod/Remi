const CREDENTIAL_ENV_NAME = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)(?:_|$)/iu;
const KNOWN_CREDENTIAL_ENV_NAMES = new Set([
  "MULTIREMI_FEISHU_APP_ID",
  "MULTIREMI_FEISHU_APP_SECRET",
]);

export function redactNotificationError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
  additionalValues: readonly string[] = [],
): string {
  let message = error instanceof Error ? error.message : String(error);
  const values = new Set<string>();
  for (const value of additionalValues) {
    if (value) values.add(value);
  }
  for (const [name, value] of Object.entries(env)) {
    if (value && (KNOWN_CREDENTIAL_ENV_NAMES.has(name) || CREDENTIAL_ENV_NAME.test(name))) {
      values.add(value);
    }
  }
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    message = message.split(value).join("***");
  }
  return message;
}
