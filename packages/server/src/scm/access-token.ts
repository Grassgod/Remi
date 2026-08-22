import type { MultiremiScmProvider } from "@multiremi/contracts/types.js";

export type CodebaseAccessToken = {
  kind: "jwt" | "bearer";
  secret: string;
};

export function parseCodebaseAccessToken(value: string): CodebaseAccessToken {
  const token = value.trim();
  if (token.startsWith("jwt:")) return { kind: "jwt", secret: token.slice(4) };
  if (token.startsWith("bearer:")) return { kind: "bearer", secret: token.slice(7) };
  return { kind: "bearer", secret: token };
}

export function codebaseAuthHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const token = parseCodebaseAccessToken(value);
  return token.kind === "jwt"
    ? { "X-Code-User-JWT": token.secret }
    : { Authorization: `Bearer ${token.secret}` };
}

export function scmGitCredentialPassword(provider: MultiremiScmProvider, value: string): string {
  return provider === "codebase" ? parseCodebaseAccessToken(value).secret : value;
}
