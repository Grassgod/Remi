import type { RemiData } from "../remi-data.js";

export function registerAuthHandlers(router: any, data: RemiData) {
  router.get("/api/v1/auth/status", () => {
    return Response.json(data.readTokenStatus());
  });
}
