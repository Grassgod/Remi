/**
 * Simple bearer token authentication middleware
 */

export function checkAuth(req: Request, authToken: string): boolean {
  if (!authToken) return true; // no token configured = auth disabled

  const header = req.headers.get("Authorization");
  if (header === `Bearer ${authToken}`) return true;

  const url = new URL(req.url);
  if (url.searchParams.get("token") === authToken) return true;

  return false;
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
