import { Buffer } from "node:buffer";

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
    addCredentialRepresentations(values, value);
  }
  for (const [name, value] of Object.entries(env)) {
    if (value && (KNOWN_CREDENTIAL_ENV_NAMES.has(name) || CREDENTIAL_ENV_NAME.test(name))) {
      addCredentialRepresentations(values, value);
    }
  }
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    message = message.split(value).join("***");
  }
  return message;
}

function addCredentialRepresentations(values: Set<string>, value: string | undefined): void {
  if (!value) return;
  addSingleCredentialRepresentations(values, value);
  const trimmed = value.trim();
  if (trimmed && trimmed !== value) addSingleCredentialRepresentations(values, trimmed);
}

function addSingleCredentialRepresentations(values: Set<string>, value: string): void {
  values.add(value);
  try {
    const encoded = encodeURIComponent(value);
    values.add(encoded);
    values.add(encoded.replace(/%20/gu, "+"));
    values.add(encoded.replace(/%[0-9A-F]{2}/gu, (match) => match.toLowerCase()));
  } catch {
    // Raw and Base64 forms still provide a safe fallback for malformed Unicode.
  }
  values.add(Buffer.from(value, "utf8").toString("base64"));
  values.add(Buffer.from(value, "utf8").toString("base64url"));
}
