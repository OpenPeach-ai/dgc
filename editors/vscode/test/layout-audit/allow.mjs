// Findings of the layout audit left on purpose. Each entry names findings (their check, their surface and their name,
// the last two as patterns) and says why they stay. An entry that matches nothing fails the audit's own test, so the
// list can't outlive what it excuses. Two kinds are here: a rule the maintainer already made, written where the code
// makes it (the stylesheet or the module says so in its own comment), and what the brief leaves for 0.53 (the broad
// unification of controls). Not a *.test.mjs file.
const HOME_CARD_SCALE = "0.53 (the unification of controls, which the brief leaves out of this pass): Home's cards draw their own buttons at a card's scale (26px, and 34px for an empty Home's first choices), as uir2c-icons.test.mjs already notes for their glyphs. Every one of them would move together.";
export const ALLOW = [
  // ---- rules the maintainer already made ----------------------------------------------------------------------------
  { check: "unreachable", surface: "^(a Pip's chat and page|a Pip's chat \\(long words\\)|the Pips list)$", what: " › .*, on or off$",
    reason: "His rule, in src/pips.css (@container max-width 240px): at the narrowest side bar a Pip's on/off switch gives way to its name, in its chat's head and (at 170px) on its row in the list; the switch is on the Pip's page." },
  { check: "unreachable", surface: "^(a Pip's chat and page|a Pip's chat \\(long words\\))$", what: "pip-composer.* › (Routines|Dictate)$",
    reason: "His call of 14 Nov, in src/pips.css (@container max-width 200px): the prompt box's row of controls never wraps, and at VS Code's narrowest side bar (170px) seven buttons do not fit it; the routines chip (they are on the Pip's page) and dictation (voice mode is beside it) give way." },
  { check: "unreachable", surface: "^(a Work session|chats with awkward words)$", what: "bar footer › (Context used|This model)",
    reason: "The footer's own rule, in media/main.css (@media max-width 320px and 290px, measured live 10 Nov): information gives way before a control. The context meter and the cache clock are read-outs; /context and the cache dialog still say them." },
  { check: "unreachable", surface: "^Settings$", what: "nav-head › Collapse navigation$",
    reason: "Below 640px Settings' navigation is already folded to its menu button: there is nothing left to collapse, so its own Collapse button is not drawn." },
  { check: "unreachable", surface: "^Home's cards that ask$", what: "dgc-hub-card › (Allow|Not now|Allow once|Deny|Create|Reject)$",
    reason: "media/shared/hub.js (cutNow): a card answers by itself only where its whole question can be read where it is drawn; on a narrower card the answers give way to Review (or Open), which opens the same question with the same answers. A product rule, not a layout slip: listed in the report for his decision." },
  { check: "unreachable", surface: "^(the Library \\(side bar\\)|lists of 200 with awkward names|Home's cards that ask)$", what: "dgc-dock-bar › New$",
    reason: "media/shared/dock.js (fit): at 170px a dock of six pins has no room at its smallest tile and steps aside whole, its “+” with it. New work, New chat and New Pip stay on their own tabs' heads; on the Library tab and on an opened Home card nothing else says New. Listed in the report for his decision." },
  { check: "unreachable", surface: "^Notes on Home$", what: "^card section\\.hc-card\\.hc-note › ",
    reason: "Notes is a list beside the open note from 580px and one of the two at a time below it (the app's own layout): with a note open in a narrow side bar, the list's tools (New note, Search, Sort, the folders) are one press away, on Back; they are measured in the list's own state." },
  // ---- 0.53: the unification of controls -----------------------------------------------------------------------------
  { check: "heights", surface: "^(Home|Notes on Home)", what: "(hc-btn|hc-qb|hc-new-btn|hc-save|hc-note-new|nt-folder).* is outside the button family$", reason: HOME_CARD_SCALE },
  { check: "heights", surface: "^the Pips list$", what: "pip-picker-button is outside the button family$",
    reason: "0.53 (the unification of controls): the New Pip dialog's character picker is 32px tall because it holds a Pip's face beside its name; it is a picker with a picture, not a command button, and belongs with the fields (34px on that dialog)." },
  { check: "consistency", surface: "^every surface$", what: "^(A menu's rows|A field): ",
    reason: "0.53, in the brief's own words: “the broad unification of controls is 0.53”. The report's table says what each surface measures (a field is 28px on nine surfaces, 26 on Home's cards, 34 and 36 on a Pip's page and its dialogs; a menu's rows are 30px everywhere but a Pip's slash menu and Settings' Add menu), so the pass has its list." },
];
