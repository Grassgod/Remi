import type { RemiData } from "../remi-data.js";

export function registerStatusHandlers(router: any, data: RemiData) {
  router.get("/api/v1/status", () => {
    return Response.json(data.getStatus());
  });
}
