import type { MultiremiWebSocketClient } from "@multiremi/api/helpers.js";

export function fanoutBrowserClient(userId: string): { client: MultiremiWebSocketClient; frames: string[] } {
  const frames: string[] = [];
  return {
    client: {
      data: {
        kind: "browser",
        connectedAt: "2026-09-27T00:00:00.000Z",
        workspaceId: "local",
        authenticated: true,
        userId,
        accessToken: null,
      },
      sendText: (frame) => { frames.push(frame); },
      close: () => {},
    },
    frames,
  };
}
