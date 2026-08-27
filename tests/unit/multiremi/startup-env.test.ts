import { describe, expect, it } from "bun:test";
import {
  SESSION_ARCHIVE_DEGRADATION_MESSAGE,
  evaluateStartupEnv,
  observableConfiguration,
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

  it("emits the searchable Session Archive degradation when direct upload is unset", () => {
    const result = evaluateStartupEnv({ NODE_ENV: "test" });

    expect(result.degradations).toEqual([{
      id: "session_archive_direct_upload",
      status: "disabled",
      effectiveValue: null,
      message: SESSION_ARCHIVE_DEGRADATION_MESSAGE,
    }]);
    expect(result.degradations[0]!.message).toContain("Session Archive direct upload disabled");
    expect(result.degradations[0]!.message).toContain("8 MiB");
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

  it("exposes only the credential-free effective direct origin", () => {
    expect(observableConfiguration("https://api.example.test")).toEqual([{
      id: "session_archive_direct_upload",
      status: "enabled",
      effectiveValue: "https://api.example.test",
      detail: "Session Archive content uploads use the direct API origin",
    }]);
    expect(observableConfiguration(null)[0]).toMatchObject({
      id: "session_archive_direct_upload",
      status: "disabled",
      effectiveValue: null,
    });
  });
});
