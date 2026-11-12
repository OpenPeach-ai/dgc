// What the Work sessions list is sent for the Library row's tests and pictures (test/folder-row-browser.test.mjs):
// five folders (this window's, one with a very long path, one gone, one whose own name is very long) and nine
// sessions across them, so "View all" is offered. Made-up folders only. Not a *.test.mjs file.
const LONG = "/home/me/clients/northwind-traders/2026/storefront-redesign/packages/checkout-service";
const WORDY = "/home/me/code/storefront-redesign-checkout-service-next-generation";
export const FOLDERS = [
  { folder: "/home/me/code/shop", shown: "~/code/shop", name: "shop", here: true, exists: true, sessions: 4, pips: 2 },
  { folder: "/home/me/code/garden", shown: "~/code/garden", name: "garden", here: false, exists: true, sessions: 2, pips: 0 },
  { folder: LONG, shown: LONG.replace("/home/me", "~"), name: "checkout-service", here: false, exists: true, sessions: 1, pips: 1 },
  { folder: "/home/me/code/notes", shown: "~/code/notes", name: "notes", here: false, exists: false, sessions: 1, pips: 0 },
  { folder: WORDY, shown: WORDY.replace("/home/me", "~"), name: "storefront-redesign-checkout-service-next-generation", here: false, exists: true, sessions: 1, pips: 0 },
];
const stamp = (minutesAgo) => { const d = new Date(Date.now() - minutesAgo * 60000), p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const row = (id, name, minutes, count, at, extra = {}) => ({ id, path: `/s/${id}.json`, name, preview: "", when: stamp(minutes), count, open: false,
  project: FOLDERS[at].shown, projectPath: FOLDERS[at].folder, projectName: FOLDERS[at].name, ...(FOLDERS[at].here ? {} : { here: false }), ...(FOLDERS[at].exists ? {} : { gone: true }), ...extra });
export const EVERYWHERE = [row("s-shop-1", "Checkout totals round the wrong way", 130, 5, 0), row("s-garden-1", "Water the tomatoes on Fridays", 1500, 6, 1),
  row("s-long-1", "Card form loses focus after an error", 4400, 12, 2), row("s-shop-2", "Dark mode for the settings page", 11000, 31, 0), row("s-notes-1", "Tidy the reading list", 20000, 2, 3),
  row("s-wordy-1", "Move the cart to the new service", 26000, 9, 4), row("s-shop-3", "Receipts as PDF", 30000, 14, 0), row("s-garden-2", "Seed order for spring", 41000, 4, 1), row("s-shop-4", "Faster search on the orders page", 52000, 22, 0)];
/** The list as the host posts it: `choice` is "" (All projects) or one folder. */
export const listOf = (choice = "") => ({ type: "sessions_list", error: "", searchable: true, query: "", more: false,
  folders: { choice, rows: FOLDERS }, ...(choice ? { folder: FOLDERS.find((f) => f.folder === choice).shown, folderPath: choice } : {}),
  items: EVERYWHERE.filter((s) => !choice || s.projectPath === choice) });
