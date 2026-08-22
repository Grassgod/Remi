import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ScmConnection, WorkspaceRepository } from "@multiremi/core/types";
import zhCommon from "../../locales/zh-Hans/common.json";
import zhSettings from "../../locales/zh-Hans/settings.json";

const connectionsRef = vi.hoisted(() => ({ current: [] as ScmConnection[] }));
const repositoriesRef = vi.hoisted(() => ({ current: [] as WorkspaceRepository[] }));
const invalidateQueries = vi.hoisted(() => vi.fn());
const createScmConnection = vi.hoisted(() => vi.fn());
const updateScmConnection = vi.hoisted(() => vi.fn());
const verifyScmConnection = vi.hoisted(() => vi.fn());
const bindScmRepository = vi.hoisted(() => vi.fn());
const unbindScmRepository = vi.hoisted(() => vi.fn());
const deleteScmConnection = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({
    data: options.queryKey[0] === "repositories"
      ? { repositories: repositoriesRef.current, total: repositoriesRef.current.length }
      : { connections: connectionsRef.current },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries }),
  queryOptions: <T,>(options: T) => options,
}));

vi.mock("@multiremi/core/api", () => ({
  api: {
    getBaseUrl: () => "",
    createScmConnection,
    updateScmConnection,
    verifyScmConnection,
    deleteScmConnection,
    bindScmRepository,
    unbindScmRepository,
  },
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, warning: toastWarning, error: toastError },
}));

import { ScmConnectionsSection } from "./scm-connections-section";

const TEST_RESOURCES = {
  "zh-Hans": { common: zhCommon, settings: zhSettings },
};

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="zh-Hans" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function connection(overrides: Partial<ScmConnection> = {}): ScmConnection {
  return {
    id: "connection-1",
    workspaceId: "workspace-1",
    name: "GitHub",
    provider: "github",
    mode: "poll",
    baseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
    enabled: true,
    pollIntervalSeconds: 60,
    repositoryScope: "all",
    isDefault: true,
    accessTokenSet: true,
    accessTokenHint: "e1Fs",
    webhookSecretSet: false,
    webhookSecretHint: null,
    verificationStatus: "unverified",
    verifiedAt: null,
    verificationIdentity: null,
    verifiedRepositoryCount: 0,
    verifiedRepositoryTotal: 0,
    verificationErrorCode: null,
    verificationError: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    repositories: [],
    ...overrides,
  };
}

const repository: WorkspaceRepository = {
  id: "repository-1",
  name: "Remi",
  url: "git@github.com:Grassgod/Remi.git",
  source: "github",
  description: null,
  default_branch: "main",
  imported_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
};

async function openCreateDialog() {
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "添加连接" })[0]!);
  return user;
}

describe("ScmConnectionsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionsRef.current = [];
    repositoriesRef.current = [repository];
    createScmConnection.mockResolvedValue({ connection: connection() });
    updateScmConnection.mockResolvedValue({ connection: connection() });
    bindScmRepository.mockResolvedValue({ connection: connection() });
    unbindScmRepository.mockResolvedValue(undefined);
    verifyScmConnection.mockResolvedValue({
      connection: connection({ verificationStatus: "valid" }),
    });
  });

  it("renders localized labels instead of raw ingestion mode values", async () => {
    const user = await openCreateDialogAfterRender();
    const modeSelect = screen.getByRole("combobox");
    expect(modeSelect).toHaveTextContent("主动拉取");
    expect(modeSelect).not.toHaveTextContent("poll");

    await user.click(modeSelect);
    await user.click(await screen.findByRole("option", { name: "Webhook" }));
    expect(modeSelect).toHaveTextContent("Webhook");

    await user.click(modeSelect);
    await user.click(await screen.findByRole("option", { name: "混合" }));
    expect(modeSelect).toHaveTextContent("混合");
  });

  it("defaults to all current and future repositories and verifies after saving", async () => {
    const user = await openCreateDialogAfterRender();

    expect(screen.getByRole("radio", { name: /全部当前及未来仓库/ })).toBeChecked();
    expect(screen.queryByText(repository.name)).not.toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText("输入可读取仓库事件和 Git 内容的 Token"),
      "github-token",
    );
    await user.click(screen.getByRole("button", { name: "保存并验证" }));

    await waitFor(() => expect(createScmConnection).toHaveBeenCalledWith("workspace-1",
      expect.objectContaining({ repositoryScope: "all", accessToken: "github-token" }),
    ));
    expect(createScmConnection.mock.calls[0]?.[1]).not.toHaveProperty("repositoryIds");
    expect(bindScmRepository).not.toHaveBeenCalled();
    expect(verifyScmConnection).toHaveBeenCalledWith("workspace-1", "connection-1");
    expect(toastSuccess).toHaveBeenCalledWith("连接已保存并完成验证");
  });

  it("creates a selected repository scope atomically", async () => {
    const user = await openCreateDialogAfterRender();
    await user.click(screen.getByRole("radio", { name: /仅指定仓库/ }));
    await user.click(screen.getByRole("checkbox"));
    await user.type(
      screen.getByPlaceholderText("输入可读取仓库事件和 Git 内容的 Token"),
      "github-token",
    );
    await user.click(screen.getByRole("button", { name: "保存并验证" }));

    await waitFor(() => expect(createScmConnection).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        repositoryScope: "selected",
        repositoryIds: ["repository-1"],
      }),
    ));
    expect(bindScmRepository).not.toHaveBeenCalled();
  });

  it.each(["Webhook", "混合"])(
    "requires a webhook secret in %s mode",
    async (modeLabel) => {
      const user = await openCreateDialogAfterRender();
      await user.type(
        screen.getByPlaceholderText("输入可读取仓库事件和 Git 内容的 Token"),
        "github-token",
      );

      const modeSelect = screen.getByRole("combobox");
      await user.click(modeSelect);
      await user.click(await screen.findByRole("option", { name: modeLabel }));

      const saveButton = screen.getByRole("button", { name: "保存并验证" });
      expect(saveButton).toBeDisabled();
      await user.type(
        screen.getByPlaceholderText("用于验证平台发送的请求"),
        "webhook-secret",
      );
      expect(saveButton).toBeEnabled();
    },
  );

  it("replaces selected repository bindings atomically when editing", async () => {
    const secondRepository: WorkspaceRepository = {
      ...repository,
      id: "repository-2",
      name: "Remi Docs",
      url: "git@github.com:Grassgod/remi-docs.git",
    };
    const currentConnection = connection({
      repositoryScope: "selected",
      repositories: [{
        id: "binding-1",
        workspaceId: "workspace-1",
        connectionId: "connection-1",
        repositoryId: repository.id,
        repositoryUrl: repository.url,
        externalId: null,
        owner: null,
        name: repository.name,
        defaultBranch: "main",
        enabled: true,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }],
    });
    connectionsRef.current = [currentConnection];
    repositoriesRef.current = [repository, secondRepository];
    render(<ScmConnectionsSection workspaceId="workspace-1" canManage />, {
      wrapper: I18nWrapper,
    });
    const user = userEvent.setup();
    await user.click(screen.getByTitle("编辑连接"));
    const repositoryCheckboxes = screen.getAllByRole("checkbox");
    await user.click(repositoryCheckboxes[0]!);
    await user.click(repositoryCheckboxes[1]!);
    await user.click(screen.getByRole("button", { name: "保存并验证" }));

    await waitFor(() => expect(verifyScmConnection).toHaveBeenCalled());
    expect(updateScmConnection).toHaveBeenCalledWith(
      "workspace-1",
      "connection-1",
      expect.objectContaining({
        repositoryScope: "selected",
        repositoryIds: ["repository-2"],
      }),
    );
    expect(bindScmRepository).not.toHaveBeenCalled();
    expect(unbindScmRepository).not.toHaveBeenCalled();
  });

  it("never reports an invalid token as successfully verified", async () => {
    verifyScmConnection.mockResolvedValue({
      connection: connection({
        verificationStatus: "invalid",
        verificationError: "Token 已过期",
      }),
    });
    const user = await openCreateDialogAfterRender();
    await user.type(
      screen.getByPlaceholderText("输入可读取仓库事件和 Git 内容的 Token"),
      "expired-token",
    );
    await user.click(screen.getByRole("button", { name: "保存并验证" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Token 已过期"));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("surfaces partial verification identity and repository coverage", () => {
    connectionsRef.current = [connection({
      name: "Work GitHub",
      verificationStatus: "partial",
      verificationIdentity: "grassgod",
      verifiedRepositoryCount: 2,
      verifiedRepositoryTotal: 3,
      verificationError: "一个仓库无权限",
    })];
    render(<ScmConnectionsSection workspaceId="workspace-1" canManage />, {
      wrapper: I18nWrapper,
    });

    expect(screen.getByText("部分可访问")).toBeInTheDocument();
    expect(screen.getByText("grassgod")).toBeInTheDocument();
    expect(screen.getByText("可访问 2 / 3 个仓库")).toBeInTheDocument();
    expect(screen.getByText("一个仓库无权限")).toHaveClass("text-destructive");
  });
});

async function openCreateDialogAfterRender() {
  render(<ScmConnectionsSection workspaceId="workspace-1" canManage />, {
    wrapper: I18nWrapper,
  });
  return openCreateDialog();
}
