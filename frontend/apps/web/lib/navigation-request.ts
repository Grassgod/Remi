/** Next strips Flight control headers; only HTML document requests may seed. */
export function navigationRequestKind(headers: Pick<Headers, "get">): "document" | "soft-nav" {
  if (headers.get("rsc") === "1" || headers.get("next-router-prefetch") === "1"
    || headers.get("next-router-segment-prefetch") !== null
    || headers.get("purpose") === "prefetch") return "soft-nav";
  const destination = headers.get("sec-fetch-dest");
  if (destination) return ["document", "iframe", "frame"].includes(destination) ? "document" : "soft-nav";
  return (headers.get("accept") ?? "").split(",").some(value =>
    ["text/html", "application/xhtml+xml"].includes(value.trim().split(";")[0]?.toLowerCase() ?? ""))
    ? "document" : "soft-nav";
}
