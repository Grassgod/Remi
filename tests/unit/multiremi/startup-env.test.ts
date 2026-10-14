import { describe, expect, it } from "bun:test";
import {
  evaluateStartupEnv,
  redactDatabaseUrl,
  redactSecret,
} from "../../../packages/server/src/config/startup-env.js";

describe("API startup environment", () => {
  it("reports every missing production requirement", () => {
    const result = evaluateStartupEnv({ NODE_ENV: "production" });

    expect(result.missingRequired).toEqual([
      "MULTIREMI_DATABASE_URL",
      "MULTIREMI_TOKEN",
      "JWT_SECRET",
    ]);
  });

  it("keeps local and test startup independent from api.env", () => {
    expect(evaluateStartupEnv({}).missingRequired).toEqual([]);
    expect(evaluateStartupEnv({ NODE_ENV: "test" }).missingRequired).toEqual([]);
  });

  it("lets an explicit development/test NODE_ENV outrank a configured database URL", () => {
    // Choosing Postgres locally is a storage choice, not a deployment. jwtSecret()
    // still serves DEFAULT_JWT_SECRET here, so startup must not demand JWT_SECRET.
    const local = { MULTIREMI_DATABASE_URL: "postgresql://dev:dev@127.0.0.1:5432/multiremi" };

    expect(evaluateStartupEnv({ ...local, NODE_ENV: "development" }).missingRequired).toEqual([]);
    expect(evaluateStartupEnv({ ...local, NODE_ENV: "test" }).missingRequired).toEqual([]);
    expect(evaluateStartupEnv({ ...local, NODE_ENV: "Development" }).missingRequired).toEqual([]);
    expect(evaluateStartupEnv({ ...local, NODE_ENV: "development" }).effective.mode).toBe("local");
  });

  it("still treats a configured database URL as production when NODE_ENV is unset", () => {
    const result = evaluateStartupEnv({
      MULTIREMI_DATABASE_URL: "postgresql://svc:pw@db.internal:5432/multiremi",
    });

    expect(result.effective.mode).toBe("production");
    expect(result.missingRequired).toEqual(["MULTIREMI_TOKEN", "JWT_SECRET"]);
  });

  it("reports no degradation for a local API without a direct origin", () => {
    expect(evaluateStartupEnv({ NODE_ENV: "test" }).degradations).toEqual([]);
  });

  it("redacts secrets and database passwords containing special characters", () => {
    const password = "p@ss:wo/rd";
    const encodedPassword = encodeURIComponent(password);
    const databaseUrl = `postgresql://service:${encodedPassword}@db.internal:5432/multiremi?sslmode=require`;
    const rawSpecialCharacterUrl = `postgresql://service:${password}@db.internal:5432/multiremi`;

    expect(redactSecret("top-secret-value")).toBe("set(length=16)");
    expect(redactSecret("  ")).toBe("unset");
    expect(redactDatabaseUrl(databaseUrl)).toBe("postgresql://service@db.internal:5432/multiremi");
    expect(redactDatabaseUrl(databaseUrl)).not.toContain(password);
    expect(redactDatabaseUrl(databaseUrl)).not.toContain(encodedPassword);
    expect(redactDatabaseUrl(rawSpecialCharacterUrl)).toBe("postgresql://service@db.internal:5432/multiremi");
  });
});
