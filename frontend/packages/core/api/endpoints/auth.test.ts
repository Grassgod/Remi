import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { AuthEndpoints } from "./auth";

afterEach(() => vi.unstubAllGlobals());

const account = { id: "user-password", email: "reader@localhost", name: "Reader" };
const password = "fixture-password-42";

describe("AuthEndpoints.passwordLogin", () => {
  it("posts credentials in the body and accepts local-domain email identities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: "session-fixture", user: { ...account, password: "must-not-reach-auth-state" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const endpoint = new AuthEndpoints(new HttpClient("http://api.example.test", { logger }));

    const result = await endpoint.passwordLogin(account.email, password);

    expect(result.token).toBe("session-fixture");
    expect(result.user).toMatchObject(account);
    expect(result.user).not.toHaveProperty("password");
    expect(fetchMock).toHaveBeenCalledWith("http://api.example.test/auth/password", expect.objectContaining({
      method: "POST", body: JSON.stringify({ email: account.email, password }),
    }));
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(password);
  });

  it.each([
    {},
    { token: "session-fixture" },
    { token: "", user: account },
    { token: "   ", user: account },
    { token: 123, user: account },
    { token: "session-fixture", user: { ...account, id: "" } },
    { token: "session-fixture", user: { ...account, email: 123 } },
    { token: "session-fixture", user: { id: "user-password" } },
  ])("rejects a malformed successful login response: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    const endpoint = new AuthEndpoints(new HttpClient("http://api.example.test"));
    await expect(endpoint.passwordLogin(account.email, password)).rejects.toThrow(ApiContractError);
  });
});
