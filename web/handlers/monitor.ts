import type { RemiData } from "../remi-data.js";

export function registerMonitorHandlers(router: any, data: RemiData) {
  router.get("/api/v1/monitor/stats", () => {
    return Response.json(data.getMonitorStats());
  });
}
