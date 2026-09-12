// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Skill, UpdateSkillRequest } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enSkills from "../../locales/en/skills.json";

const api = vi.hoisted(() => ({ getSkill: vi.fn(), updateSkill: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({ useWorkspacePaths: () => ({ skills: () => "/local/skills" }) }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  skillDetailOptions: (_wsId: string, skillId: string) => ({ queryKey: ["skill", "ws-1", skillId], queryFn: () => api.getSkill(skillId) }),
  agentListOptions: () => ({ queryKey: ["agents"], queryFn: async () => [] }),
  memberListOptions: () => ({ queryKey: ["members"], queryFn: async () => [] }),
  selectSkillAssignments: () => new Map(),
  workspaceKeys: { skills: () => ["skills"], agents: () => ["agents"] },
}));
vi.mock("@multiremi/core/runtimes", () => ({ runtimeListOptions: () => ({ queryKey: ["runtimes"], queryFn: async () => [] }) }));
vi.mock("@multiremi/core/permissions", () => ({ useSkillPermissions: () => ({ canEdit: { allowed: true } }) }));
vi.mock("../hooks/use-can-edit-skill", () => ({ useCanEditSkill: () => true }));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ replace: vi.fn() }),
  AppLink: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("../../layout/breadcrumb-header", () => ({ BreadcrumbHeader: ({ leaf, actions }: { leaf: ReactNode; actions: ReactNode }) => <header>{leaf}{actions}</header> }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SkillDetailPage } from "./skill-detail-page";

const binaryFile = { id: "file-1", skill_id: "skill-1", path: "assets/pixel.png", content: "iVBORw0KGgoA/w==", encoding: "base64" as const, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };
const skill: Skill = { id: "skill-1", workspace_id: "ws-1", name: "Review", description: "Review code", content: "# Review", config: {}, created_by: "user-1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", files: [binaryFile] };

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<I18nProvider locale="en" resources={{ en: { common: enCommon, skills: enSkills } }}>
    <QueryClientProvider client={queryClient}><SkillDetailPage skillId="skill-1" /></QueryClientProvider>
  </I18nProvider>);
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSkill.mockResolvedValue(skill);
  api.updateSkill.mockImplementation((_id: string, data: UpdateSkillRequest) => Promise.resolve({
    ...skill, ...data, updated_at: "2026-09-02T00:00:00Z",
    files: data.files?.map(file => ({ ...binaryFile, ...file })) ?? skill.files,
  }));
});

describe("Skill detail binary drafts", () => {
  it("preserves binary bytes and encoding when saving metadata and reseeding the saved draft", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "pixel.png" }));
    expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute("href", `data:application/octet-stream;base64,${binaryFile.content}`);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Skill name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateSkill).toHaveBeenCalledWith("skill-1", expect.objectContaining({ files: [{ path: binaryFile.path, content: binaryFile.content, encoding: "base64" }] })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Download file" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Updated description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateSkill).toHaveBeenCalledTimes(2));
    expect(api.updateSkill.mock.calls[1]![1].files).toEqual([{ path: binaryFile.path, content: binaryFile.content, encoding: "base64" }]);
  });

  it("retains binary encoding when discarding a draft", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "pixel.png" }));
    fireEvent.change(screen.getByLabelText("Skill name"), { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Skill name")).toHaveValue("Review");
    expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute("href", `data:application/octet-stream;base64,${binaryFile.content}`);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("detects an encoding-only server change and restores the server encoding on discard", async () => {
    api.getSkill.mockResolvedValue({ ...skill, files: [{ ...binaryFile, encoding: undefined }] });
    const queryClient = show();
    fireEvent.click(await screen.findByRole("button", { name: "pixel.png" }));
    expect(screen.getByDisplayValue(binaryFile.content)).toBeInTheDocument();
    await act(async () => {
      queryClient.setQueryData(["skill", "ws-1", "skill-1"], { ...skill, updated_at: "2026-09-03T00:00:00Z" });
    });
    expect(await screen.findByText("Someone else updated this skill")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByDisplayValue(binaryFile.content)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });
});
