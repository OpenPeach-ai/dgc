// The video player the three chats share (Work, ChatDGC, a Pip's chat): a video job DGC started (dgc/videos.py), drawn
// in the same made-picture figure a picture is (so folding a turn's pictures folds its videos too). While the job runs
// it shows the provider's state, the time so far and Stop; once made, a <video> with its poster frame, its length and
// size, and Open (the system player), Show in folder and Save to project…; a failure or a Stop says what happened.
// The bytes come from the extension host (src/videoHost.ts) as a blob: URL; the page never reads a file itself.
(function () {
  "use strict";
  let post = null;
  const waiting = new Map();
  let seq = 0;
  const ENDED = new Set(["done", "failed", "cancelled"]);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function size(bytes) {
    const n = Number(bytes) || 0;
    return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  }
  function clock(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function money(job) {
    const cost = job.cost_usd ?? job.estimate_usd;
    if (cost === 0) return "free";
    if (cost === null || cost === undefined) return "price unknown";
    return `$${Number(cost) < 0.1 ? Number(cost).toFixed(3) : Number(cost).toFixed(2)}`;
  }
  /** "Made a 5 s video with fal Wan 2.2 5B · 720p · $0.15", as dgc/videos.py line() says it. */
  function line(job) {
    const who = job.label || job.generator_name || job.generator || "the generator";
    const seconds = job.result?.seconds ?? job.duration_s;
    const length = seconds ? `${Math.round(Number(seconds))} s` : "a";
    if (job.state === "done") return `Made a ${length} video with ${who} · ${job.resolution || ""} · ${money(job)}`;
    if (job.state === "failed") return `The video with ${who} wasn't made: ${job.error?.message || job.status || "failed"}`;
    if (job.state === "cancelled") return `Stopped the video with ${who}.${job.charged ? ` ${job.charged}` : ""}`;
    return `Making a ${length} video with ${who}`;
  }
  function elapsed(job) {
    const started = Number(job.started) || 0;
    return started ? Math.max(0, (Number(job.finished) || Date.now() / 1000) - started) : Number(job.elapsed_s) || 0;
  }

  function figures(id) {
    const found = [];
    const visit = (root) => {
      root.querySelectorAll?.(`figure.made-video[data-video-job="${CSS.escape(id)}"]`).forEach((f) => found.push(f));
      root.querySelectorAll?.("*").forEach((n) => { if (n.shadowRoot) visit(n.shadowRoot); });
    };
    visit(document);
    return found;
  }

  function request(message, done) {
    if (typeof post !== "function") return;
    const requestId = `video-${++seq}`;
    const timer = setTimeout(() => { if (waiting.delete(requestId)) done({ error: "no answer" }); }, 60_000);
    waiting.set(requestId, { done, timer });
    post({ ...message, requestId });
    return requestId;
  }

  function dispose(fig) {
    fig._disposed = true;
    fig._observer?.disconnect();
    clearTimeout(fig._poll);
    releaseMedia(fig);
  }

  function releaseMedia(fig) {
    const pending = waiting.get(fig._request);
    if (pending) { clearTimeout(pending.timer); waiting.delete(fig._request); }
    if (fig._src) { URL.revokeObjectURL(fig._src); fig._src = null; }
    fig.querySelector("video")?.removeAttribute("src");
    fig._loading = false;
  }

  function load(fig) {
    const job = fig._job;
    const path = job?.result?.path;
    if (!path || fig._loading || fig._src) return;
    fig._loading = true;
    fig._request = request({ type: "videoData", path }, (answer) => {
      if (fig._disposed || !fig.isConnected) { dispose(fig); return; }
      fig._loading = false;
      const video = fig.querySelector("video");
      if (answer.poster && video) video.poster = answer.poster;
      if (answer.data && video) {
        fig._src = URL.createObjectURL(new Blob([answer.data], { type: answer.mime || "video/mp4" }));
        video.src = fig._src;
        fig.classList.remove("loading");
      } else if (answer.error) {
        fig.classList.remove("loading");
        const said = fig.querySelector(".video-note") || fig.appendChild(el("p", "video-note"));
        said.textContent = answer.error === "too_large" ? `${size(answer.bytes)}: too large to play here. Open plays it.`
          : String(answer.error);
      }
    });
  }

  function actionButton(label, title, type, fig) {
    const button = el("button", "made-image-save video-act", label);
    button.type = "button";
    button.title = title;
    button.addEventListener("click", () => {
      const path = fig._job?.result?.path;
      if (path && typeof post === "function") post({ type, path });
    });
    return button;
  }

  function render(fig) {
    const job = fig._job || {};
    if (job.state !== "done" || fig._path !== job.result?.path) releaseMedia(fig);
    fig._path = job.result?.path;
    fig.dataset.state = String(job.state || "queued");
    fig.replaceChildren();
    if (job.state === "done") {
      const video = el("video", "video-player");
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.setAttribute("aria-label", `Video: ${job.prompt || job.result?.file || "made by DGC"}`);
      if (fig._src) video.src = fig._src; else fig.classList.add("loading");
      fig.appendChild(video);
      const r = job.result || {};
      const facts = [r.seconds ? clock(r.seconds) : job.duration_s ? clock(job.duration_s) : "",
        r.width && r.height ? `${r.width}×${r.height}` : job.resolution || "", r.bytes ? size(r.bytes) : ""]
        .filter(Boolean).join(" · ");
      const caption = el("figcaption", "made-image-caption video-caption");
      caption.appendChild(el("span", "video-name", r.file || "video"));
      if (facts) caption.appendChild(el("span", "video-facts", facts));
      fig.appendChild(caption);
      const row = el("div", "video-actions");
      row.appendChild(actionButton("Open", "Open in the system player", "videoOpen", fig));
      row.appendChild(actionButton("Show in folder", "Show the file in its folder", "videoReveal", fig));
      if (fig._options?.save !== false) {
        row.appendChild(actionButton("Save to project…", "Save a copy into this project (assets/ unless you choose another place)",
          "videoSave", fig));
      }
      fig.appendChild(row);
      load(fig);
      return;
    }
    if (ENDED.has(job.state)) {
      fig.appendChild(el("p", `video-said ${job.state === "failed" ? "error" : ""}`, line(job)));
      return;
    }
    const wait = el("div", "video-wait");
    wait.setAttribute("role", "status");
    wait.appendChild(el("span", "video-spinner"));
    const words = el("span", "video-words");
    words.textContent = `${job.label || "Video"}: ${job.status || "starting"} · ${clock(elapsed(job))}`;
    wait.appendChild(words);
    const stop = el("button", "act video-stop", "Stop");
    stop.type = "button";
    stop.title = "Stop this video (at the provider, where it can)";
    stop.addEventListener("click", () => {
      stop.disabled = true;
      stop.textContent = "Stopping…";
      request({ type: "videoStop", job: job.id }, (answer) => {
        if (answer?.answer?.state) update(answer.answer);
        else if (answer?.error) { stop.disabled = false; stop.textContent = "Stop"; }
      });
    });
    if (job.can_stop !== false) wait.appendChild(stop);
    fig.appendChild(wait);
    const caption = el("figcaption", "made-image-caption video-caption");
    caption.appendChild(el("span", "video-facts", [job.duration_s ? `${job.duration_s} s` : "", job.resolution || "",
      job.price || money(job), job.minutes || ""].filter(Boolean).join(" · ")));
    fig.appendChild(caption);
  }

  /** A figure for one job. `options.poll`: read the job's state from the host every few seconds while it runs (a Pip's
   *  chat, which hears no video_job events); `options.save`: offer Save to project… (default true). */
  function figure(job, options = {}) {
    const fig = el("figure", "made-image made-video");
    fig.dataset.videoJob = String(job.id || "");
    fig._job = { ...job };
    fig._options = options;
    render(fig);
    // Observe both the page and its containing shadow tree (standalone Pip chats).
    const observe = () => {
      if (!fig.isConnected) { dispose(fig); return; }
      fig._observer.observe(fig.getRootNode(), { childList: true, subtree: true });
    };
    fig._observer = new MutationObserver(observe);
    fig._observer.observe(document, { childList: true, subtree: true });
    queueMicrotask(observe);
    if (options.poll) watch(fig);
    return fig;
  }

  function watch(fig) {
    const tick = () => {
      if (!fig.isConnected || ENDED.has(fig._job?.state)) return;
      request({ type: "videoJob", job: fig._job.id }, (answer) => { if (answer?.job) update(answer.job); });
      fig._poll = setTimeout(tick, 5000);
    };
    fig._poll = setTimeout(tick, 2000);
  }

  /** A job changed (a video_job event, a chat card's update, a poll): every figure of it is redrawn. */
  function update(job) {
    if (!job || !job.id) return;
    for (const fig of figures(String(job.id))) {
      const before = fig._job?.state;
      const path = fig._job?.result?.path;
      fig._job = { ...fig._job, ...job };
      if (before === "done" && job.state === "done" && path === fig._job?.result?.path && fig.querySelector("video")) continue;
      render(fig);
    }
  }

  /** A host's answer: true when it was one of these. */
  function message(msg) {
    if (!msg || !["videoData", "videoJob", "videoStopped"].includes(msg.type)) return false;
    const pending = waiting.get(msg.requestId);
    if (pending) {
      waiting.delete(msg.requestId);
      clearTimeout(pending.timer);
      pending.done(msg);
    }
    return true;
  }

  // The time so far, on every running job's line.
  setInterval(() => {
    document.querySelectorAll('figure.made-video[data-state="queued"] .video-words, figure.made-video[data-state="running"] .video-words')
      .forEach((words) => {
        const fig = words.closest("figure");
        const job = fig?._job;
        if (job) words.textContent = `${job.label || "Video"}: ${job.status || "starting"} · ${clock(elapsed(job))}`;
      });
  }, 1000);

  globalThis.DgcVideo = { host: (fn) => { post = fn; }, hasHost: () => typeof post === "function", figure, update,
    message, dispose, line, clock, size };
})();
