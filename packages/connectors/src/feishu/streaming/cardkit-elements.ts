// Raw CardKit element CRUD for the Feishu streaming session (audit S17 split).
//
// Every call here is one authenticated HTTP request against
// /cardkit/v1/cards/<cardId>/…, carrying the monotonic `sequence` Feishu uses to
// order concurrent edits. The session owns that counter (it is session identity)
// and hands each call a CardRef it already reserved; this module owns the wire
// format, the 5xx retry and the log/failure bookkeeping.
//
// Bodies were moved verbatim off FeishuStreamingSession; `this.state.cardId` ->
// `ref.cardId`, `this.log` -> `this.deps.log`, `this._getToken()` ->
// `this.deps.getToken()`, `this._consecutiveFailures = 0` -> `deps.onSuccess()`
// and `this._onElementApiFailed()` -> `deps.onFailure()`.
import { resolveApiBase } from "@shared/feishu-domain.js";
import type { FeishuDomain } from "../types.js";

/** A card id plus the sequence number reserved for one edit. */
export interface CardRef {
  cardId: string;
  seq: number;
}

export interface CardKitDeps {
  domain?: FeishuDomain;
  getToken: () => Promise<string>;
  log: (msg: string) => void;
  /** A request succeeded — resets the consecutive-failure count. */
  onSuccess: () => void;
  /** A request failed — may trip the session into degraded mode. */
  onFailure: () => void;
}

export class CardKitElements {
  constructor(private deps: CardKitDeps) {}

  // ── Element update (raw API call with retry on 5xx) ────────

  async update(ref: CardRef, elementId: string, content: string): Promise<void> {
    const apiBase = resolveApiBase(this.deps.domain);
    const seq = ref.seq;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `${apiBase}/cardkit/v1/cards/${ref.cardId}/elements/${elementId}/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${await this.deps.getToken()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content,
              sequence: seq,
              uuid: `s_${ref.cardId}_${seq}`,
            }),
          },
        );
        if (res.ok) {
          this.deps.onSuccess();
          return;
        }
        const body = await res.text().catch(() => "");
        if (attempt === 0 && res.status >= 500) {
          this.deps.log(`Update ${elementId} HTTP ${res.status}, retrying...`);
          continue;
        }
        this.deps.log(
          `Update ${elementId} HTTP ${res.status}: ${body.slice(0, 300)}`,
        );
        this.deps.onFailure();
        return;
      } catch (e) {
        if (attempt === 0) {
          this.deps.log(`Update ${elementId} failed, retrying: ${String(e)}`);
          continue;
        }
        this.deps.log(`Update ${elementId} failed: ${String(e)}`);
        this.deps.onFailure();
      }
    }
  }

  /**
   * Append a new element to a container (e.g. collapsible_panel) via CardKit insert element API.
   */
  async append(
    ref: CardRef,
    targetElementId: string,
    element: Record<string, unknown>,
  ): Promise<void> {
    const apiBase = resolveApiBase(this.deps.domain);
    const seq = ref.seq;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `${apiBase}/cardkit/v1/cards/${ref.cardId}/elements`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${await this.deps.getToken()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "append",
              target_element_id: targetElementId,
              sequence: seq,
              elements: JSON.stringify([element]),
            }),
          },
        );
        if (res.ok) {
          this.deps.onSuccess();
          return;
        }
        const body = await res.text().catch(() => "");
        if (attempt === 0 && res.status >= 500) {
          this.deps.log(`Append to ${targetElementId} HTTP ${res.status}, retrying...`);
          continue;
        }
        this.deps.log(`Append to ${targetElementId} HTTP ${res.status}: ${body.slice(0, 300)}`);
        this.deps.onFailure();
        return;
      } catch (e) {
        if (attempt === 0) {
          this.deps.log(`Append to ${targetElementId} failed, retrying: ${String(e)}`);
          continue;
        }
        this.deps.log(`Append to ${targetElementId} failed: ${String(e)}`);
        this.deps.onFailure();
      }
    }
  }

  async remove(ref: CardRef, elementId: string): Promise<void> {
    const apiBase = resolveApiBase(this.deps.domain);
    const seq = ref.seq;
    try {
      const res = await fetch(
        `${apiBase}/cardkit/v1/cards/${ref.cardId}/elements/${elementId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await this.deps.getToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sequence: seq, uuid: `d_${ref.cardId}_${seq}` }),
        },
      );
      if (res.ok) {
        this.deps.onSuccess();
      } else {
        const body = await res.text().catch(() => "");
        this.deps.log(`Delete ${elementId} HTTP ${res.status}: ${body.slice(0, 200)}`);
        this.deps.onFailure();
      }
    } catch (e) {
      this.deps.log(`Delete ${elementId} failed: ${String(e)}`);
      this.deps.onFailure();
    }
  }

  /** Insert element via CardKit API, throwing on failure (unlike fire-and-forget insertAfter). */
  async insertAfterOrThrow(
    ref: CardRef,
    afterElementId: string,
    element: Record<string, unknown>,
  ): Promise<void> {
    const apiBase = resolveApiBase(this.deps.domain);
    const seq = ref.seq;
    const res = await fetch(
      `${apiBase}/cardkit/v1/cards/${ref.cardId}/elements`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.deps.getToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "insert_after",
          target_element_id: afterElementId,
          sequence: seq,
          elements: JSON.stringify([element]),
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`CardKit insert_after ${afterElementId} HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
  }

  async insertAfter(
    ref: CardRef,
    afterElementId: string,
    element: Record<string, unknown>,
  ): Promise<void> {
    const apiBase = resolveApiBase(this.deps.domain);
    const seq = ref.seq;
    try {
      const res = await fetch(
        `${apiBase}/cardkit/v1/cards/${ref.cardId}/elements`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.deps.getToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "insert_after",
            target_element_id: afterElementId,
            sequence: seq,
            elements: JSON.stringify([element]),
          }),
        },
      );
      if (res.ok) {
        this.deps.onSuccess();
      } else {
        const body = await res.text().catch(() => "");
        this.deps.log(`InsertAfter ${afterElementId} HTTP ${res.status}: ${body.slice(0, 300)}`);
        this.deps.onFailure();
      }
    } catch (e) {
      this.deps.log(`InsertAfter ${afterElementId} failed: ${String(e)}`);
      this.deps.onFailure();
    }
  }

  /**
   * Flip streaming_mode off via PATCH /settings — the prerequisite for switching
   * to im.message.patch full-card rebuilds. `summary` is resolved late, at the
   * point the request body is built.
   */
  async closeStreamingMode(ref: CardRef, summary: () => string): Promise<void> {
    const apiBase = resolveApiBase(this.deps.domain);
    const seq = ref.seq;
    try {
      const res = await fetch(
        `${apiBase}/cardkit/v1/cards/${ref.cardId}/settings`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${await this.deps.getToken()}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: summary() },
              },
            }),
            sequence: seq,
            uuid: `c_${ref.cardId}_${seq}`,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.deps.log(`Close streaming mode HTTP ${res.status}: ${body.slice(0, 300)}`);
      } else {
        this.deps.log(`Close streaming mode OK (streaming_mode=false)`);
      }
    } catch (e) {
      this.deps.log(`Close streaming mode failed: ${String(e)}`);
    }
  }
}
