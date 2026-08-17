// Pages advanced mode: 301 any non-vibedgc host → vibedgc.com (browser + curl), else serve assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const h = url.hostname;
    if (!/(^|\.)vibedgc\.com$/i.test(h) && !/\.pages\.dev$/i.test(h)) {
      url.protocol = "https:"; url.hostname = "vibedgc.com";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  }
};
