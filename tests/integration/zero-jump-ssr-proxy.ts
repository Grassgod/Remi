/** SSR-only gateway: browser rewrites still reach the real API directly. */
export function startSsrProbe(apiOrigin: string, port: number) {
  const reads: Array<{ path: string; query: string; startedAt: number }> = [];
  let timeoutIssueId: string | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      const url = new URL(request.url);
      reads.push({ path: url.pathname, query: url.search, startedAt: Date.now() });
      if (timeoutIssueId && url.pathname === `/api/issues/${timeoutIssueId}`) await Bun.sleep(1_200);
      const response = await fetch(`${apiOrigin}${url.pathname}${url.search}`, {
        method: request.method, headers: request.headers, redirect: "manual", signal: request.signal,
      });
      const headers = new Headers(response.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
      return new Response(response.body, { status: response.status, headers });
    },
    error() { return new Response("SSR probe request cancelled", { status: 502 }); },
  });
  return { origin: `http://127.0.0.1:${server.port}`, reads,
    setTimeoutIssue(id?: string) { timeoutIssueId = id; }, stop() { server.stop(true); } };
}
