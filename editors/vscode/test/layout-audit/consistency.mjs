// One kind of control on every surface: what the walk measured of each (auditRest: buttons, fields, icon buttons;
// auditLayers: a menu's rows), compared across the surfaces. A menu's rows and a field are one thing everywhere, so a
// second look is a finding; the rest is the table in the report. Not a *.test.mjs file.
export function consistency(audit) {
  const ctx = { surface: "every surface", state: "compared", width: 0, height: 0, theme: "dark" };
  const across = (bag, kind) => { const looks = new Map(); for (const [surface, kinds] of Object.entries(bag)) for (const [look, who] of Object.entries(kind ? kinds[kind] || {} : kinds)) { if (!looks.has(look)) looks.set(look, []); looks.get(look).push({ surface, who }); } return looks; };
  const tell = (what, looks) => {
    if (looks.size < 2) return;
    const list = [...looks.entries()].sort((a, b) => b[1].length - a[1].length), [usual, ...rest] = list;
    for (const [look, where] of rest) audit.add("consistency", ctx, `${what}: ${look}`, `${what} measures ${usual[0]} on ${usual[1].length} surface${usual[1].length > 1 ? "s" : ""} (${usual[1].slice(0, 3).map((w) => w.surface).join(", ")}…) and ${look} on ${where.map((w) => `${w.surface} (${w.who.slice(0, 2).join(", ")})`).slice(0, 4).join("; ")}.`);
  };
  tell("A menu's rows", across(audit.menus));
  tell("A field", across(audit.kinds, "field"));
  audit.table = { menus: Object.fromEntries(across(audit.menus)), ...Object.fromEntries(["button", "field", "icon button", "plain button"].map((k) => [k, Object.fromEntries(across(audit.kinds, k))])) };
}
