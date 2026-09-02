// Pages advanced mode: 301 any non-vibedgc host → vibedgc.com (browser + curl), else serve assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const h = url.hostname;
    // docs.vibedgc.com is a convenience entry point, not a second origin: redirect it onto the
    // canonical /docs path so the pages keep one URL, one place in search, and relative links
    // (../index.html, assets/docs.css) resolve the same way from either address.
    if (/^docs\.vibedgc\.com$/i.test(h)) {
      url.protocol = "https:"; url.hostname = "vibedgc.com";
      url.pathname = url.pathname === "/" ? "/docs/" : "/docs" + url.pathname;
      return Response.redirect(url.toString(), 301);
    }
    if (!/(^|\.)vibedgc\.com$/i.test(h) && !/\.pages\.dev$/i.test(h)) {
      url.protocol = "https:"; url.hostname = "vibedgc.com";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  }
};
