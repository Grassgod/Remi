import { describe, expect, it } from "vitest";
import { deriveChangeRequestRepositoryName } from "./change-request-repository";

describe("deriveChangeRequestRepositoryName", () => {
  it("prefers the synced repository binding name", () => {
    expect(deriveChangeRequestRepositoryName({
      repositoryName: "Remi",
      url: "https://github.com/acme/other/pull/4",
    })).toBe("Remi");
  });

  it("ignores blank binding names", () => {
    expect(deriveChangeRequestRepositoryName({
      repositoryName: "  ",
      url: "https://github.com/acme/widgets/pull/4",
    })).toBe("widgets");
  });

  it("parses GitHub pull request URLs", () => {
    expect(deriveChangeRequestRepositoryName({
      repositoryName: null,
      url: "https://github.com/Grassgod/Remi/pull/4",
    })).toBe("Remi");
  });

  it("parses merge request URLs with and without the /-/ marker", () => {
    expect(deriveChangeRequestRepositoryName({
      repositoryName: null,
      url: "https://code.example.org/taoze/personal_automation/merge_requests/12",
    })).toBe("personal_automation");
    expect(deriveChangeRequestRepositoryName({
      repositoryName: null,
      url: "https://gitlab.example.org/group/subgroup/project/-/merge_requests/9",
    })).toBe("project");
  });

  it("returns null for missing, malformed, or unrecognized URLs", () => {
    expect(deriveChangeRequestRepositoryName({ repositoryName: null, url: null })).toBeNull();
    expect(deriveChangeRequestRepositoryName({ repositoryName: null, url: "not a url" })).toBeNull();
    expect(deriveChangeRequestRepositoryName({ repositoryName: null, url: "https://example.test/change/1" })).toBeNull();
  });
});
