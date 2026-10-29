"""Tally: the steps DGC takes this session, by tool. It only counts; it never stops anything."""
import dgc_mod as dm

mod = dm.Mod()
counts = {}
failed = {}


def saved_counts(value):
    if not isinstance(value, dict):
        return {}
    return {name: count for name, count in value.items()
            if isinstance(name, str) and name.isprintable() and len(name) <= 64
            and type(count) is int and 0 <= count <= 1_000_000_000}


def table():
    rows = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return dm.Box(dm.Table(["Tool", "Steps", "Failed"], [[name, n, failed.get(name, 0)] for name, n in rows])
                  if rows else dm.Text("No steps yet.", tone="muted"), title="Steps this session")


def status():
    total = sum(counts.values())
    return dm.Text(f"{total} step{'s' if total != 1 else ''}" + (f" · {sum(failed.values())} failed" if failed else ""))


@mod.on("tool.call")
def called(event):
    name = str(event.get("tool") or "?")
    counts[name] = counts.get(name, 0) + 1
    mod.state_set("counts", counts)


@mod.on("tool.result")
def returned(event):
    if event.get("is_error"):
        name = str(event.get("tool") or "?")
        failed[name] = failed.get(name, 0) + 1
        mod.state_set("failed", failed)


@mod.on("turn.complete")
def turn_done(event):
    mod.set_ui("status", status())
    mod.set_ui("pane", table())


@mod.render("status")
def draw_status():
    counts.clear()
    counts.update(saved_counts(mod.state_get("counts", {})))
    failed.clear()
    failed.update(saved_counts(mod.state_get("failed", {})))
    return status()


@mod.render("pane")
def draw_pane():
    return table()


@mod.command("tally")
def show(args):
    return table()


mod.run()
