import type { ScmProviderCapabilities } from "./types.js";

export const GITHUB_SCM_CAPABILITIES: ScmProviderCapabilities = {
  provider: "github",
  streams: {
    default_branch: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: [],
    },
    change_requests: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: ["The pull-request list has no updated-since cursor; polling scans by updated time."],
    },
    comments: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: ["Polling cannot observe comments created and deleted between two runs."],
    },
    reviews: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: ["GitHub exposes reviews per pull request, so polling first discovers changed pull requests."],
    },
    pipelines: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: [
        "Canonical pipeline events cover GitHub Actions workflow runs only; GitHub Checks check_run events are ignored.",
      ],
    },
  },
  supportsDeleteTombstones: false,
  supportsConditionalRequests: true,
};

export const CODEBASE_SCM_CAPABILITIES: ScmProviderCapabilities = {
  provider: "codebase",
  streams: {
    default_branch: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: [],
    },
    change_requests: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: [],
    },
    comments: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: ["Thread polling is scoped to merge requests and has no repository-wide delete tombstone."],
    },
    reviews: {
      poll: true,
      webhook: true,
      pollFidelity: "inferred",
      webhookFidelity: "exact",
      limitations: ["Review status is read per merge request."],
    },
    pipelines: {
      poll: true,
      webhook: false,
      pollFidelity: "inferred",
      webhookFidelity: null,
      limitations: ["Codebase repository webhooks do not expose check-run or pipeline events."],
    },
  },
  supportsDeleteTombstones: false,
  supportsConditionalRequests: false,
};

export const SCM_PROVIDER_CAPABILITIES = {
  github: GITHUB_SCM_CAPABILITIES,
  codebase: CODEBASE_SCM_CAPABILITIES,
} as const;
