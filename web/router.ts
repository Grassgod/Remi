/**
 * Simple URL pattern-based router for Bun.serve()
 */

type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: RouteHandler;
}

export class Router {
  private _routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    this._routes.push({
      method: method.toUpperCase(),
      pattern: new URLPattern({ pathname: path }),
      handler,
    });
  }

  get(path: string, handler: RouteHandler) { this.add("GET", path, handler); }
  post(path: string, handler: RouteHandler) { this.add("POST", path, handler); }
  put(path: string, handler: RouteHandler) { this.add("PUT", path, handler); }
  delete(path: string, handler: RouteHandler) { this.add("DELETE", path, handler); }

  match(req: Request): { handler: RouteHandler; params: Record<string, string> } | null {
    const method = req.method.toUpperCase();

    for (const route of this._routes) {
      if (route.method !== method) continue;
      const result = route.pattern.exec(req.url);
      if (result) {
        return {
          handler: route.handler,
          params: result.pathname.groups as Record<string, string>,
        };
      }
    }
    return null;
  }
}
