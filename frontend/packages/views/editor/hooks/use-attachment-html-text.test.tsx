import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import { useAttachmentHtmlText } from "./use-attachment-html-text";
const { read } = vi.hoisted(() => ({ read: vi.fn(async (id: string) => ({ text: id, originalContentType: "text/html" })) }));
vi.mock("@multiremi/core/api", () => ({ api: { getAttachmentTextContent: read } }));

describe("attachment content cache scope", () => {
  it("reuses a body within a workspace and separates other ids and workspaces", async () => {
    const qc = new QueryClient();
    let slug = "one";
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><WorkspaceSlugProvider slug={slug}>{children}</WorkspaceSlugProvider></QueryClientProvider>;
    const hook = renderHook((id: string) => useAttachmentHtmlText(id), { wrapper, initialProps: "a" });
    await waitFor(() => expect(hook.result.current.data?.text).toBe("a"));
    hook.rerender("b"); await waitFor(() => expect(hook.result.current.data?.text).toBe("b"));
    hook.rerender("a"); expect(hook.result.current.data?.text).toBe("a");
    expect(read).toHaveBeenCalledTimes(2);
    slug = "two"; hook.rerender("a");
    await waitFor(() => expect(hook.result.current.data?.text).toBe("a"));
    expect(read).toHaveBeenCalledTimes(3);
  });
});
