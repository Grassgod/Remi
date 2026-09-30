import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";

function temporaryDatabase(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "m432-immediate-"));
  return { dir, file: join(dir, "store.db") };
}

describe("SQLite outer transaction write lock", () => {
  it("shows why a deferred read cannot upgrade after another connection commits", () => {
    const { dir, file } = temporaryDatabase();
    const first = openSqliteDatabase(file);
    const second = openSqliteDatabase(file);
    try {
      first.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 200");
      second.exec("PRAGMA busy_timeout = 200");
      first.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
      first.run("INSERT INTO probe (id, value) VALUES (1, 0)");

      let error: unknown;
      try {
        first.transaction(() => {
          first.query("SELECT value FROM probe WHERE id = 1").get();
          second.run("UPDATE probe SET value = 1 WHERE id = 1");
          first.run("UPDATE probe SET value = 2 WHERE id = 1");
        }).deferred();
      } catch (caught) {
        error = caught;
      }
      expect((error as { code?: string } | undefined)?.code).toBe("SQLITE_BUSY_SNAPSHOT");
      expect(first.query("SELECT value FROM probe WHERE id = 1").get()).toEqual({ value: 1 });
    } finally {
      second.close();
      first.close();
      rmSync(dir, { recursive: true });
    }
  });

  it("waits for a second process before a read-then-write Store update", async () => {
    const { dir, file } = temporaryDatabase();
    const db = openSqliteDatabase(file);
    let child: ReturnType<typeof Bun.spawn> | null = null;
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      const agent = store.createAgent({ name: "Before lock", provider: "codex" });
      db.exec("CREATE TABLE lock_probe (value TEXT NOT NULL)");

      const worker = `
        import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
        const db = openSqliteDatabase(${JSON.stringify(file)});
        db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
        process.stdout.write("locked\\n");
        await Bun.sleep(600);
        db.run("INSERT INTO lock_probe (value) VALUES ('worker committed')");
        db.exec("COMMIT");
        process.stdout.write(\`committed \${Date.now()}\\n\`);
        db.close();
      `;
      child = Bun.spawn([process.execPath, "-e", worker], { stdout: "pipe", stderr: "pipe" });
      const output = child.stdout;
      if (!output || typeof output === "number") throw new Error("lock worker stdout is not a pipe");
      const stdout = output.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      const nextLine = async (): Promise<string> => {
        while (!buffered.includes("\n")) {
          const { done, value } = await stdout.read();
          if (done) throw new Error("lock worker exited before reporting its state");
          buffered += decoder.decode(value, { stream: true });
        }
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line;
      };

      expect(await nextLine()).toBe("locked");
      const started = Date.now();
      expect(store.updateAgent(agent.id, { name: "After lock" }).name).toBe("After lock");
      const finished = Date.now();
      const committed = await nextLine();
      expect(committed.startsWith("committed ")).toBe(true);
      expect(finished).toBeGreaterThanOrEqual(Number(committed.slice("committed ".length)));
      expect(finished - started).toBeGreaterThanOrEqual(500);
      expect(await child.exited).toBe(0);
      expect(db.query("SELECT value FROM lock_probe").all()).toEqual([{ value: "worker committed" }]);
      expect(store.getAgent(agent.id)?.name).toBe("After lock");
    } finally {
      if (child && child.exitCode === null) child.kill();
      if (child) await child.exited;
      db.close();
      rmSync(dir, { recursive: true });
    }
  }, 15_000);
});
