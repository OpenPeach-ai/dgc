// Edge 301: any host that is NOT vibedgc.com (or the *.pages.dev preview) → vibedgc.com,
// preserving path + query. Covers every old domain, present and future.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const h = url.hostname;
  if (!/(^|\.)vibedgc\.com$/i.test(h) && !/\.pages\.dev$/i.test(h)) {
    url.protocol = "https:";
    url.hostname = "vibedgc.com";
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
