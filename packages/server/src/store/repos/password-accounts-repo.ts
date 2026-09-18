import type { MultiremiUser } from "@multiremi/contracts/types.js";
import { nowIso } from "@multiremi/ids.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { WorkspacesRepo } from "./workspaces-repo.js";
import type { AccessTokensRepo } from "./access-tokens-repo.js";

export class PasswordAccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export interface ConfigurePasswordAccountInput {
  email: string;
  password: string;
  name?: string;
  workspaceId?: string;
}

const HASH_OPTIONS = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
let dummyHash: Promise<string> | undefined;

export function normalizePasswordLoginEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@(?:localhost|[^\s@.]+(?:\.[^\s@.]+)+)$/.test(email)) return null;
  return email;
}

/** Password hashes stay in a private table and never enter the public User model. */
export class PasswordAccountsRepo {
  constructor(private db: SqlDatabase, private workspaces: WorkspacesRepo, private accessTokens: AccessTokensRepo) {}

  async configure(input: ConfigurePasswordAccountInput): Promise<{ user: MultiremiUser; workspaceId: string; role: "owner" }> {
    const email = normalizePasswordLoginEmail(input.email);
    if (!email) throw new PasswordAccountError("A valid email address is required", 400);
    if (typeof input.password !== "string" || input.password.length < 6 || input.password.length > 1024) {
      throw new PasswordAccountError("Password must contain between 6 and 1024 characters", 400);
    }
    if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200)) {
      throw new PasswordAccountError("Name must contain between 1 and 200 characters", 400);
    }
    const workspaceId = input.workspaceId ?? "local";
    if (typeof workspaceId !== "string" || !workspaceId.trim()) throw new PasswordAccountError("Workspace id is required", 400);
    if (workspaceId !== "local" && !this.workspaces.getWorkspace(workspaceId)) throw new PasswordAccountError("Workspace not found", 404);
    // Hash outside the synchronous transaction; recheck identity inside it so
    // simultaneous setup requests cannot create conflicting account bindings.
    this.findUniqueUser(email);
    const hash = await Bun.password.hash(input.password, HASH_OPTIONS);
    return this.db.transaction(() => {
      const existing = this.findUniqueUser(email);
      const credential = this.db.query("SELECT user_id FROM multiremi_password_credentials WHERE login_email = ?").get(email) as { user_id: string } | null;
      if (credential && credential.user_id !== existing?.id) throw new PasswordAccountError("Login email is already bound to another account", 409);
      const user = existing ?? this.workspaces.getOrCreateUser({ email, name: input.name?.trim() });
      if (workspaceId === "local") this.workspaces.ensureLocalWorkspace();
      const now = nowIso();
      this.db.run(
        `INSERT INTO multiremi_password_credentials (user_id, login_email, password_hash, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET login_email = excluded.login_email, password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
        [user.id, email, hash, now],
      );
      // Reconfiguration invalidates browser sessions without revoking personal
      // automation credentials or changing any other user's account.
      this.db.run("UPDATE multiremi_access_tokens SET revoked_at = ? WHERE user_id = ? AND type = 'pat' AND purpose = 'session' AND revoked_at IS NULL", [now, user.id]);
      const member = this.workspaces.findWorkspaceMemberForUser(user.id, workspaceId);
      if (member) {
        if (member.role !== "owner") this.workspaces.updateWorkspaceMember(member.id, { role: "owner" });
      } else {
        this.workspaces.createWorkspaceMember({ workspaceId, userId: user.id, name: user.name, email: user.email, role: "owner" });
      }
      return { user, workspaceId, role: "owner" as const };
    })();
  }

  async login(email: string, password: string): Promise<{ user: MultiremiUser; token: string } | null> {
    const credential = this.db.query("SELECT user_id, password_hash FROM multiremi_password_credentials WHERE login_email = ?").get(email) as { user_id: string; password_hash: string } | null;
    const hash = credential?.password_hash ?? await (dummyHash ??= Bun.password.hash(crypto.randomUUID(), HASH_OPTIONS)
      .catch((error) => { dummyHash = undefined; throw error; }));
    try {
      if (!await Bun.password.verify(password, hash) || !credential) return null;
    } catch {
      return null;
    }
    if (!credential.user_id.startsWith("usr_")) return null;
    const user = this.workspaces.getUser(credential.user_id);
    if (!user) return null;
    const session = await this.accessTokens.createAccessToken({
      workspaceId: "local", userId: user.id, name: "Password login",
      type: "pat", purpose: "session", expiresInDays: 30,
    }, () => {
      // Token hashing is asynchronous too. Recheck inside the token insertion
      // transaction, after every await, so a concurrent reset invalidates login.
      const current = this.db.query("SELECT password_hash FROM multiremi_password_credentials WHERE user_id = ?").get(user.id) as { password_hash: string } | null;
      if (current?.password_hash !== hash) throw new Error("Password changed during login");
    });
    return { user, token: session.token };
  }

  private findUniqueUser(email: string): MultiremiUser | null {
    const users = this.db.query("SELECT id FROM multiremi_users WHERE lower(email) = ? LIMIT 2").all(email) as Array<{ id: string }>;
    if (users.length > 1) throw new PasswordAccountError("Email matches multiple users; choose an unambiguous account email", 409);
    if (users[0] && !users[0].id.startsWith("usr_")) throw new PasswordAccountError("The legacy local identity cannot be used for password login; choose a separate account email", 409);
    return users[0] ? this.workspaces.getUser(users[0].id) : null;
  }
}
