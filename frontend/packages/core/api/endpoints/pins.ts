import type {
  CreatePinRequest,
  PinnedItem,
  PinnedItemType,
  ReorderPinsRequest,
} from "../../types";
import type { HttpClient } from "../http";

export class PinsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Pins
  async listPins(): Promise<PinnedItem[]> {
    return this.http.fetch("/api/pins");
  }

  async createPin(data: CreatePinRequest): Promise<PinnedItem> {
    return this.http.fetch("/api/pins", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deletePin(itemType: PinnedItemType, itemId: string): Promise<void> {
    await this.http.fetch(`/api/pins/${itemType}/${itemId}`, { method: "DELETE" });
  }

  async reorderPins(data: ReorderPinsRequest): Promise<void> {
    await this.http.fetch("/api/pins/reorder", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }
}
