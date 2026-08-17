// Edge 301: any old domain → vibedgc.com (same path+query). vibedgc.com falls through and serves.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (/(^|\.)dagucc?hicode\.com$/i.test(url.hostname)) {
    url.protocol = "https:";
    url.hostname = "vibedgc.com";
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
