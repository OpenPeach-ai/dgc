// Sample notes for the Notes tests and pictures: neutral ones (a ferry, seeds, a book club), as the host keeps them
// (test/support/notes-host.mjs, seed). Fourteen notes, three folders, two in Recently deleted. Not a *.test.mjs file.
const MIN = 60000, H = 3600000, D = 86400000;
export const FOLDERS = [{ id: "trips1", name: "Trips" }, { id: "home01", name: "Home" }, { id: "read01", name: "Reading" }];
export const FERRY = "Ferry to Porto\nLeaves from the **north quay**, not the old terminal. *Be there 40 minutes early* with the car.\n## Before we go\n- [x] Book the 09:40\n- [x] Check the car deck height\n- [ ] Ask about bikes\n- [ ] Print the tickets\n## On the day\n1. Fuel the evening before\n2. Leave by 07:30\n3. Coffee at the quay\n\n- Timetable: [ferries.example/porto](https://ferries.example/porto)\n- Cabin 214, deck 5";
/** `now`: the moment the sample is made for (each note's times are counted back from it). */
export function sample(now = Date.now()) {
  const n = (id, text, folder, ago, more = {}) => ({ id, text, folder, edited: now - ago, created: now - ago - (more.age ?? 2 * D), ...more });
  return { folders: FOLDERS, notes: [
    n("ferry1", FERRY, "trips1", 5 * MIN, { pinned: true }),
    n("wifi01", "House Wi-Fi and the alarm\nThe router is under the stairs.\nGuest network: the one ending in 5G", "home01", 26 * H, { pinned: true }),
    n("seeds1", "Seeds for spring\nTomatoes, basil, sweet peas", "home01", 2 * H),
    n("bank01", "Call the bank about the card\nThen book the ferry", "", 27 * H),
    n("book01", "Book club: the March pick\nThree to choose from", "read01", 3 * D),
    n("rice01", "Lemon rice\n1. Rinse the rice twice\n2. Mustard seeds first\n3. Lemon at the end", "home01", 4 * D),
    n("pass01", "Passport numbers\nKept with the tickets, in the blue folder", "trips1", 6 * D),
    n("bike01", "Bike service\nBrake pads, chain, the back light", "home01", 12 * D),
    n("read02", "Reading list\nTwelve so far", "read01", 17 * D),
    n("tide01", "Tide tables for the bay\nLow water 06:12 on Saturday, by the ferry pier", "trips1", 24 * D),
    n("pack01", "Packing for the bay\nBoots, the red flask, two maps", "trips1", 26 * D),
    n("gift01", "Gift ideas\nA kettle that whistles", "", 30 * D),
    n("fence1", "Paint for the fence\nTwo tins, green", "home01", 40 * D),
    n("poem01", "Lines I liked\nThe sea is never the same twice", "read01", 50 * D),
    n("oldf01", "Old ferry times\n07:10 and 09:40", "", 9 * D, { deleted: now - 2 * D, was: "trips1" }),
    n("shop01", "Shopping, last week\nOats, lemons, tea", "", 30 * D, { deleted: now - 26 * D, was: "" })] };
}
