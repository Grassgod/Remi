/**
 * 1Passport — unified auth token management interfaces.
 */

/** A cached token with expiry metadata. */
export interface TokenEntry {
  value: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

/** Status of a single managed token. */
export interface TokenStatus {
  service: string;
  type: string;
  valid: boolean;
  expiresAt: number;
  refreshable: boolean;
}

/** Platform-specific auth adapter (e.g., Feishu, ByteDance). */
export interface AuthAdapter {
  readonly service: string;

  /** Get a valid token, refreshing if expired. */
  getToken(type?: string): Promise<string>;

  /** Proactively check and refresh tokens nearing expiry. */
  checkAndRefresh(): Promise<void>;

  /** List current token statuses. */
  status(): TokenStatus[];

  /** Restore tokens from persistence (called on startup). */
  restoreTokens?(tokens: Record<string, TokenEntry>): void;

  /** Export current tokens for persistence. */
  exportTokens?(): Record<string, TokenEntry>;

  /** Register a callback for when tokens change (triggers persistence). */
  onTokenChange?(cb: () => void): void;
}
