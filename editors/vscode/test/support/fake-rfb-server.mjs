// A fake RFB (VNC) server for the computer tab's tests: it speaks enough of RFB 3.8 for the real noVNC viewer to connect
// and draw a screen, and it records what the viewer sends: every KeyEvent (type 4), PointerEvent (5) and ClientCutText
// (6), as the bytes that were sent. No socket: the test hands it the viewer's bytes (feed) and takes back what a server
// would answer, the way the extension host relays them (pipDesktop / pipDesktopData).
//
// The screen is one FramebufferUpdate in RRE (a ground and a few rectangles), so a 1920x1080 screen is a few hundred
// bytes, not 8 MB of raw pixels.
//
// `resizable`: the screen says its size the way a screen a viewer may resize does (ExtendedDesktopSize), and takes the
// size a viewer asks for (SetDesktopSize, type 251), as Your Browser's own screen does; every size asked is in `sizes`.
const u16 = (n) => [(n >> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const read32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

export class FakeRfbServer {
  constructor({ width = 1280, height = 800, name = "Pip", resizable = false } = {}) {
    this.width = width; this.height = height; this.name = name; this.resizable = resizable;
    this.sizes = [];             // SetDesktopSize: every [width, height] a viewer asked for
    this.buffer = new Uint8Array(0);
    this.phase = 0;              // 0 the viewer's version, 1 its security type, 2 ClientInit, 3 messages
    this.messages = [];          // every message after the handshake: { type, bytes }
    this.keys = [];              // KeyEvents in order: { down, keysym, bytes }
    this.cuts = [];              // ClientCutText: { text, extended, bytes }
    this.pointers = 0;
    this.drawn = false;
  }

  /** What the server says first. */
  hello() { return Uint8Array.from(ascii("RFB 003.008\n")); }

  /** The length of the message at the start of `b`, or 0 when more bytes are needed. */
  size(b) {
    const fixed = { 0: 20, 3: 10, 4: 8, 5: 6 };
    const type = b[0];
    if (fixed[type]) return fixed[type];
    if (type === 2) return b.length < 4 ? 0 : 4 + 4 * ((b[2] << 8) | b[3]);
    if (type === 6) { if (b.length < 8) return 0; const n = read32(b, 4) | 0; return 8 + Math.abs(n); }
    if (type === 251 && this.resizable) return b.length < 8 ? 0 : 8 + 16 * b[6];
    throw new Error(`the fake RFB server does not know viewer message ${type}`);
  }

  /** The viewer's bytes in; the server's replies out (a list of Uint8Array, possibly empty). */
  feed(bytes) {
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer); joined.set(bytes, this.buffer.length);
    this.buffer = joined;
    const out = [];
    for (;;) {
      const b = this.buffer;
      if (this.phase === 0) {
        if (b.length < 12) break;
        this.buffer = b.slice(12); this.phase = 1;
        out.push(Uint8Array.from([1, 1]));                     // one security type: None
      } else if (this.phase === 1) {
        if (b.length < 1) break;
        this.buffer = b.slice(1); this.phase = 2;
        out.push(Uint8Array.from(u32(0)));                     // SecurityResult: ok
      } else if (this.phase === 2) {
        if (b.length < 1) break;
        this.buffer = b.slice(1); this.phase = 3;
        // ServerInit: the size, a 32-bit true-colour pixel format, the desktop's name.
        out.push(Uint8Array.from([...u16(this.width), ...u16(this.height), 32, 24, 0, 1, ...u16(255), ...u16(255), ...u16(255), 16, 8, 0, 0, 0, 0,
          ...u32(this.name.length), ...ascii(this.name)]));
      } else {
        if (!b.length) break;
        const size = this.size(b);
        if (!size || b.length < size) break;
        const message = b.slice(0, size); this.buffer = b.slice(size);
        this.messages.push({ type: message[0], bytes: message });
        if (message[0] === 4) this.keys.push({ down: message[1] === 1, keysym: read32(message, 4), bytes: message });
        else if (message[0] === 5) this.pointers++;
        else if (message[0] === 6) {
          const n = read32(message, 4) | 0;
          this.cuts.push({ extended: n < 0, text: n < 0 ? null : Buffer.from(message.slice(8)).toString("latin1"), bytes: message });
        } else if (message[0] === 3 && !this.drawn) { this.drawn = true; out.push(this.picture(this.resizable ? 0 : -1)); }
        else if (message[0] === 251) {
          const w = (message[2] << 8) | message[3], h = (message[4] << 8) | message[5];
          this.sizes.push([w, h]); this.width = w; this.height = h;
          out.push(this.picture(1));                           // the new size, as this viewer asked, and the screen at it
        }
      }
    }
    return out;
  }

  /** The whole screen, once: a desktop-like picture in RRE (the viewer's pixel format: red, green, blue, spare). `why`, on a
   *  resizable screen: its size first, as ExtendedDesktopSize says it (0 the screen's own, 1 this viewer asked). */
  picture(why = -1) {
    const W = this.width, H = this.height, px = (r, g, b) => [r, g, b, 255];
    const rects = [
      [px(246, 246, 248), 0, 0, W, 28],                                       // a top bar
      [px(255, 255, 255), Math.round(W * 0.08), 70, Math.round(W * 0.6), Math.round(H * 0.6)],   // a window
      [px(47, 124, 246), Math.round(W * 0.08), 70, Math.round(W * 0.6), 26],  // its title bar
      [px(230, 232, 236), Math.round(W * 0.72), 110, Math.round(W * 0.2), Math.round(H * 0.35)], // a second window
      [px(52, 54, 62), Math.round(W / 2) - 110, H - 52, 220, 44],             // the dock
      [px(244, 178, 62), Math.round(W / 2) - 96, H - 46, 32, 32], [px(47, 124, 246), Math.round(W / 2) - 52, H - 46, 32, 32],
      [px(126, 231, 135), Math.round(W / 2) - 8, H - 46, 32, 32], [px(245, 83, 133), Math.round(W / 2) + 36, H - 46, 32, 32],
      [px(255, 0, 0), 0, 0, 8, 8], [px(0, 255, 0), W - 8, H - 8, 8, 8],        // the corners, for a test to find
    ];
    const size = why < 0 ? [] : [...u16(why), ...u16(0), ...u16(W), ...u16(H), ...u32(-308 >>> 0), 1, 0, 0, 0, ...u32(1), ...u16(0), ...u16(0), ...u16(W), ...u16(H), ...u32(0)];
    return Uint8Array.from([0, 0, ...u16(why < 0 ? 1 : 2), ...size, ...u16(0), ...u16(0), ...u16(W), ...u16(H), ...u32(2),
      ...u32(rects.length), ...px(30, 32, 40), ...rects.flatMap(([p, x, y, w, h]) => [...p, ...u16(x), ...u16(y), ...u16(w), ...u16(h)])]);
  }

  /** ServerCutText: what was copied on the computer (Latin-1, as plain RFB carries it). */
  cutText(text) { return Uint8Array.from(Buffer.concat([Buffer.from([3, 0, 0, 0, ...u32(text.length)]), Buffer.from(text, "latin1")])); }
}
