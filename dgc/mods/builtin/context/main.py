"""Context: the context window, part by part (the same breakdown /context shows), kept current after each turn."""
import dgc_mod as dm

mod = dm.Mod()
TONES = ["accent", "ok", "warn", "strong", "bad", "muted"]


def short(n):
    n = int(n or 0)
    return f"{n / 1000:.1f}K".replace(".0K", "K") if n >= 1000 else str(n)


def view():
    try:
        u = mod.usage()
    except dm.ModError as error:
        return dm.Text(f"Not available: {error}", tone="muted")
    b = u.get("breakdown") or {}
    window = int(b.get("window") or u.get("window") or 0)
    parts = b.get("categories") or []
    if not window:
        return dm.Text("This model's window isn't known.", tone="muted")
    used = sum(int(p.get("tokens") or 0) for p in parts)
    segs = [{"label": p.get("label", ""), "value": int(p.get("tokens") or 0), "tone": TONES[i % len(TONES)]}
            for i, p in enumerate(parts)]
    rows = [[p.get("label", ""), short(p.get("tokens")), f"{100 * int(p.get('tokens') or 0) / window:.1f}%"] for p in parts]
    rows += [["Kept for compaction", short(b.get("buffer")), f"{100 * int(b.get('buffer') or 0) / window:.1f}%"],
             ["Free", short(b.get("free")), f"{100 * int(b.get('free') or 0) / window:.1f}%"]]
    return dm.Box(dm.Text(f"{short(used)} of {short(window)} tokens ({100 * used / window:.0f}%)", tone="strong"),
                  dm.Bar(segs, total=window), dm.Table(["Part", "Tokens", "Share"], rows), title="Context window")


def line():
    try:
        b = (mod.usage().get("breakdown") or {})
    except dm.ModError:
        return dm.Text("ctx ?", tone="muted")
    window = int(b.get("window") or 0)
    used = sum(int(p.get("tokens") or 0) for p in b.get("categories") or [])
    return dm.Text(f"ctx {100 * used / window:.0f}%" if window else "ctx ?",
                   tone="warn" if window and used / window > 0.8 else None)


@mod.on("session.start")
@mod.on("turn.complete")
def refresh(event):
    mod.set_ui("pane", view())
    mod.set_ui("status", line())


@mod.render("pane")
def pane():
    return view()


@mod.render("status")
def status():
    return line()


@mod.command("window")
def window(args):
    return view()


mod.run()
