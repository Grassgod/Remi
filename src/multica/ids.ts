const DEFAULT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function createId(prefix: string, len = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let value = "";
  for (let i = 0; i < len; i++) {
    value += DEFAULT_ALPHABET[bytes[i] % DEFAULT_ALPHABET.length];
  }
  return `${prefix}_${value}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
