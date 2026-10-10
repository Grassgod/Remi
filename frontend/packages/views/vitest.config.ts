import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Explicit files, rather than *.test.ts: editor and hook tests also use that
// suffix. Audit value imports (including re-exports) before extending this list.
const pureTests = [
  "workspace/slug.test.ts",
  "usage/utils.test.ts",
  "common/format.test.ts",
  "issues/utils/filter.test.ts",
  "issues/utils/quote-preview.test.ts",
  "issues/utils/strip-mention-markdown.test.ts",
  "issues/utils/timeline-view.test.ts",
  "issues/utils/log-row-model.test.ts",
  "chat/lib/optimistic-log.test.ts",
  "chat/lib/copy-text.test.ts",
  "chat/lib/chat-timeline.test.ts",
  "common/task-transcript/redact.test.ts",
  "common/task-transcript/build-timeline.test.ts",
  "common/task-transcript/event-format.test.ts",
  "editor/utils/escape-markdown-label.test.ts",
  "editor/utils/highlight-match.test.ts",
  "editor/utils/highlight-markdown.test.ts",
  "projects/components/project-issue-filters.test.ts",
  "projects/components/project-issue-metrics.test.ts",
  "inbox/components/inbox-display.test.ts",
  "locales/parity.test.ts",
];

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    isolate: true,
    projects: [
      {
        extends: true,
        test: {
          name: "pure",
          environment: "node",
          setupFiles: [],
          include: pureTests,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./test/setup.ts"],
          include: ["**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, ...pureTests],
        },
      },
    ],
  },
});
