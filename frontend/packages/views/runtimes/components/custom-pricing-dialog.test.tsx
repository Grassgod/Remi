import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, setApiInstance } from "@multiremi/core/api";
import type { UsagePrice } from "@multiremi/contracts/usage-accounting";
import { afterEach, describe, expect, it, vi } from "vitest";
import locale from "../../locales/en/usage.json";
import { UsagePricingDialog } from "./custom-pricing-dialog";

vi.mock("../../i18n", () => ({ useT: () => ({ t: (selector: (value: typeof locale) => string) => selector(locale) }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Server price version editor", () => {
  it("preserves drafts after failure and sends empty rates as unknown, zero rates as free and an explicit requested alias", async () => {
    const client = new ApiClient("http://localhost"); setApiInstance(client);
    vi.spyOn(client, "getUsagePrices").mockResolvedValue([]);
    const save = vi.spyOn(client, "setUsagePrice").mockRejectedValueOnce(new Error("conflict")).mockImplementationOnce(async (_workspace, input) => ({ ...input, id: "price", workspace_id: "ws", created_at: "now" } as UsagePrice));
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    render(<QueryClientProvider client={qc}><UsagePricingDialog wsId="ws" models={[{ provider: "codex", model: "retired-model", connection_id: "historical-connection", requested_model_alias: true }]} onClose={onClose} /></QueryClientProvider>);
    const button = screen.getByRole("button", { name: locale.price.save });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.change(screen.getByLabelText(locale.table.input), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(locale.table.output), { target: { value: "12.5" } });
    fireEvent.click(button);
    await screen.findByText(locale.price.save_error);
    expect(screen.getByLabelText(locale.table.output)).toHaveValue(12.5);
    expect(onClose).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith("ws", expect.objectContaining({ provider: "codex", model: "retired-model", connection_id: "historical-connection", requested_model_alias: true,
      input_per_million: 0, output_per_million: 12.5, cache_read_per_million: null, cache_write_per_million: null, unsplit_per_million: null }));
    fireEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["usage-accounting", "ws"] });
    qc.clear();
  });
});
