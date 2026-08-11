import { describe, it, expect } from "vitest";
import {
  checkQuickCreateCliVersion,
  checkQuickCreateCliVersionAcrossRuntimes,
} from "./cli-version";

describe("checkQuickCreateCliVersion", () => {
  it("returns ok for a tagged release at or above the minimum", () => {
    expect(checkQuickCreateCliVersion("v0.2.20").state).toBe("ok");
    expect(checkQuickCreateCliVersion("0.3.1").state).toBe("ok");
  });

  it("returns too_old for a tagged release below the minimum", () => {
    expect(checkQuickCreateCliVersion("v0.2.15").state).toBe("too_old");
  });

  it("returns missing for empty or unparsable input", () => {
    expect(checkQuickCreateCliVersion("").state).toBe("missing");
    expect(checkQuickCreateCliVersion(undefined).state).toBe("missing");
    expect(checkQuickCreateCliVersion("not-a-version").state).toBe("missing");
  });

  it("treats git-describe dev builds as ok regardless of base tag", () => {
    expect(checkQuickCreateCliVersion("v0.2.15-235-gdaf0e935").state).toBe("ok");
    expect(checkQuickCreateCliVersion("v0.2.15-235-gdaf0e935-dirty").state).toBe("ok");
    expect(checkQuickCreateCliVersion("0.1.0-1-gabc1234").state).toBe("ok");
  });
});

describe("checkQuickCreateCliVersionAcrossRuntimes", () => {
  const rt = (cli_version?: string) => ({
    metadata: cli_version === undefined ? {} : { cli_version },
  });

  it("passes when any candidate runtime passes", () => {
    const result = checkQuickCreateCliVersionAcrossRuntimes([
      rt("v0.2.15"),
      rt("v0.2.26"),
    ]);
    expect(result.state).toBe("ok");
    expect(result.current).toBe("v0.2.26");
  });

  it("prefers a too_old verdict over missing when nothing passes", () => {
    const result = checkQuickCreateCliVersionAcrossRuntimes([
      rt(),
      rt("v0.2.15"),
    ]);
    expect(result.state).toBe("too_old");
    expect(result.current).toBe("v0.2.15");
  });

  it("reports missing when no candidate reported a version", () => {
    expect(checkQuickCreateCliVersionAcrossRuntimes([rt(), rt()]).state).toBe("missing");
  });

  it("reports missing for an empty candidate set", () => {
    expect(checkQuickCreateCliVersionAcrossRuntimes([]).state).toBe("missing");
  });
});
