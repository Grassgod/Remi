import { describe, expect, it } from "vitest";
import type { FeishuEndpointHealth, FeishuMessageOutcome } from "../api/schemas/feishu";
import {
  deriveEndpointState,
  deriveSourceState,
  feishuEndpointStateTone,
  feishuSourceStateTone,
  isFeishuMessageProcessed,
  pendingProposalCount,
} from "./state";

function endpoint(overrides: Partial<FeishuEndpointHealth> = {}): FeishuEndpointHealth {
  return {
    name: "personal",
    status: "ready",
    checkedAt: "2026-08-27T09:00:00.000Z",
    latencyMs: 12,
    version: "0.4.1",
    capabilities: ["messages"],
    errorCode: null,
    sourceCount: 1,
    ...overrides,
  };
}

function outcome(overrides: Partial<FeishuMessageOutcome> = {}): FeishuMessageOutcome {
  return {
    id: "out-1",
    workspaceId: "ws-1",
    messageId: "msg-1",
    outcomeKind: "issue_proposed",
    ref: "prop-1",
    reason: null,
    taskId: null,
    createdAt: "2026-08-27T09:00:00.000Z",
    ...overrides,
  };
}

describe("deriveEndpointState", () => {
  it("reports forbidden for a non-admin before anything else", () => {
    // A Member must not even learn whether a sidecar exists, so this outranks
    // both loading and not-configured.
    expect(deriveEndpointState({
      permitted: false,
      configured: true,
      endpoint: endpoint(),
      loading: false,
    })).toBe("forbidden");
  });

  it("reports checking while the first load is in flight", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: false,
      endpoint: null,
      loading: true,
    })).toBe("checking");
  });

  it("reports not_configured when no endpoint is registered", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: false,
      endpoint: null,
      loading: false,
    })).toBe("not_configured");
  });

  it("reports not_configured when configured is true but the list is empty", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: true,
      endpoint: null,
      loading: false,
    })).toBe("not_configured");
  });

  it("reports ready for a healthy sidecar", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: true,
      endpoint: endpoint(),
      loading: false,
    })).toBe("ready");
  });

  it("reports unreachable for a sidecar that failed its probe", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: true,
      endpoint: endpoint({ status: "unreachable", errorCode: "connection_refused" }),
      loading: false,
    })).toBe("unreachable");
  });

  it("reports stale when a refresh fails over an existing result", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: true,
      endpoint: endpoint(),
      loading: false,
      refreshFailed: true,
    })).toBe("stale");
  });

  it("treats an unknown status without a prior check as still checking", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: true,
      endpoint: endpoint({ status: "unknown", checkedAt: null }),
      loading: false,
    })).toBe("checking");
  });

  it("treats an unknown status after a prior check as stale", () => {
    expect(deriveEndpointState({
      permitted: true,
      configured: true,
      endpoint: endpoint({ status: "unknown" }),
      loading: false,
    })).toBe("stale");
  });

  it("does not report ready for a status the server invented", () => {
    // Enum drift downgrades instead of rendering a false all-clear.
    expect(deriveEndpointState({
      permitted: true,
      configured: true,
      endpoint: endpoint({ status: "degraded_but_fine" }),
      loading: false,
    })).toBe("stale");
  });
});

describe("deriveSourceState", () => {
  const source = { enabled: true, allowlist: [{ chatId: "oc_1", addedAt: "" }], endpointName: "personal" };

  it("reports paused for a disabled source regardless of endpoint health", () => {
    expect(deriveSourceState({
      source: { ...source, enabled: false },
      endpoint: endpoint({ status: "unreachable" }),
    })).toBe("paused");
  });

  it("reports blocked_endpoint when the sidecar is unreachable", () => {
    expect(deriveSourceState({
      source,
      endpoint: endpoint({ status: "unreachable" }),
    })).toBe("blocked_endpoint");
  });

  it("reports blocked_endpoint when the referenced name left the registry", () => {
    expect(deriveSourceState({ source, endpoint: null })).toBe("blocked_endpoint");
  });

  it("reports blocked_empty_allowlist for an enabled source with no chats", () => {
    // An empty allowlist ingests nothing — the list has to say so rather than
    // showing a green "active" next to a pipeline that moves zero messages.
    expect(deriveSourceState({
      source: { ...source, allowlist: [] },
      endpoint: endpoint(),
    })).toBe("blocked_empty_allowlist");
  });

  it("ranks an unreachable endpoint above an empty allowlist", () => {
    expect(deriveSourceState({
      source: { ...source, allowlist: [] },
      endpoint: endpoint({ status: "unreachable" }),
    })).toBe("blocked_endpoint");
  });

  it("reports degraded after consecutive failures", () => {
    expect(deriveSourceState({
      source,
      endpoint: endpoint(),
      status: { consecutiveFailures: 2, lastSuccessfulIngestAt: "2026-08-27T08:00:00.000Z" },
    })).toBe("degraded");
  });

  it("reports active for a healthy source", () => {
    expect(deriveSourceState({
      source,
      endpoint: endpoint(),
      status: { consecutiveFailures: 0, lastSuccessfulIngestAt: "2026-08-27T08:59:00.000Z" },
    })).toBe("active");
  });

  it("reports active when no status has loaded yet", () => {
    expect(deriveSourceState({ source, endpoint: endpoint(), status: null })).toBe("active");
  });
});

describe("state tones", () => {
  it("maps blocked_endpoint to danger and empty allowlist to warning", () => {
    expect(feishuSourceStateTone("blocked_endpoint")).toBe("danger");
    expect(feishuSourceStateTone("blocked_empty_allowlist")).toBe("warning");
    expect(feishuSourceStateTone("active")).toBe("ok");
    expect(feishuSourceStateTone("paused")).toBe("neutral");
  });

  it("falls back to neutral for a state the server invented", () => {
    expect(feishuSourceStateTone("quantum" as never)).toBe("neutral");
    expect(feishuEndpointStateTone("quantum" as never)).toBe("neutral");
  });

  it("maps endpoint health to tones", () => {
    expect(feishuEndpointStateTone("ready")).toBe("ok");
    expect(feishuEndpointStateTone("stale")).toBe("warning");
    expect(feishuEndpointStateTone("unreachable")).toBe("danger");
    expect(feishuEndpointStateTone("not_configured")).toBe("neutral");
  });
});

describe("pendingProposalCount", () => {
  it("counts an unanswered proposal", () => {
    expect(pendingProposalCount({ outcomes: [outcome()] })).toBe(1);
  });

  it("clears once the Issue is created", () => {
    expect(pendingProposalCount({
      outcomes: [outcome(), outcome({ id: "out-2", outcomeKind: "issue_created", ref: "MUL-9" })],
    })).toBe(0);
  });

  it("clears once a human rejects the proposal", () => {
    expect(pendingProposalCount({
      outcomes: [
        outcome(),
        outcome({ id: "out-2", outcomeKind: "dismissed", reason: "proposal_rejected" }),
      ],
    })).toBe(0);
  });

  it("does not clear on an unrelated dismissal", () => {
    expect(pendingProposalCount({
      outcomes: [outcome(), outcome({ id: "out-2", outcomeKind: "dismissed", reason: "handled offline" })],
    })).toBe(1);
  });

  it("never goes negative when more settlements than proposals are recorded", () => {
    expect(pendingProposalCount({
      outcomes: [outcome({ outcomeKind: "issue_created" })],
    })).toBe(0);
  });

  it("ignores outcomes that are not proposals", () => {
    expect(pendingProposalCount({
      outcomes: [outcome({ outcomeKind: "notified" }), outcome({ id: "out-2", outcomeKind: "reply_drafted" })],
    })).toBe(0);
  });
});

describe("isFeishuMessageProcessed", () => {
  it("is false for a null timestamp", () => {
    expect(isFeishuMessageProcessed({ processedAt: null })).toBe(false);
  });

  it("is false for an empty string, which a lenient parser may substitute", () => {
    expect(isFeishuMessageProcessed({ processedAt: "" })).toBe(false);
  });

  it("is true once a timestamp is present", () => {
    expect(isFeishuMessageProcessed({ processedAt: "2026-08-27T09:00:00.000Z" })).toBe(true);
  });
});
