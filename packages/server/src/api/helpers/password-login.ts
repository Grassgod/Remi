/** Per-app bounds protect the public password verifier's memory and hash workers. */
export class PasswordLoginLimiter {
  private windowStart = 0;
  private attempts = 0;
  private active = 0;
  private readonly accounts = new Map<string, { since: number; attempts: number }>();

  enter(now = Date.now()): boolean {
    if (now - this.windowStart >= 60_000) { this.windowStart = now; this.attempts = 0; }
    if (this.attempts >= 60 || this.active >= 4) return false;
    this.attempts++;
    this.active++;
    return true;
  }

  allowAccount(email: string, now = Date.now()): boolean {
    for (const [key, value] of this.accounts) {
      if (now - value.since >= 60_000) this.accounts.delete(key);
    }
    let account = this.accounts.get(email);
    if (!account) {
      if (this.accounts.size >= 1024) return false;
      account = { since: now, attempts: 0 };
      this.accounts.set(email, account);
    }
    if (account.attempts >= 8) return false;
    account.attempts++;
    return true;
  }

  leave(): void { this.active--; }
}
