// Pages advanced mode: 301 any non-vibedgc host → vibedgc.com (browser + curl), else serve assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const h = url.hostname;
    // docs.vibedgc.com serves the same pages under its own name: rewrite the path to /docs and
    // fetch the asset, so the address bar keeps the pretty URL. Every page carries a rel=canonical
    // pointing at vibedgc.com/docs/..., so search sees one origin rather than two copies. The two
    // links that leave the docs are absolute for the same reason — a relative ../index.html would
    // resolve back into /docs here.
    if (/^docs\.vibedgc\.com$/i.test(h)) {
      if (!url.pathname.startsWith("/docs")) {
        url.pathname = url.pathname === "/" ? "/docs/" : "/docs" + url.pathname;
      }
      const res = await env.ASSETS.fetch(new Request(url.toString(), request));
      // Pages does its own .html -> clean-URL redirect, and its Location carries the internal
      // /docs prefix. Strip it so the visitor never sees docs.vibedgc.com/docs/... .
      const loc = res.headers.get("location");
      if (loc) {
        const to = new URL(loc, url);
        if (/^docs\.vibedgc\.com$/i.test(to.hostname) && to.pathname.startsWith("/docs")) {
          to.pathname = to.pathname.slice("/docs".length) || "/";
          const out = new Response(res.body, res);
          out.headers.set("location", to.toString());
          return out;
        }
      }
      return res;
    }
    if (!/(^|\.)vibedgc\.com$/i.test(h) && !/\.pages\.dev$/i.test(h)) {
      url.protocol = "https:"; url.hostname = "vibedgc.com";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  }
};
