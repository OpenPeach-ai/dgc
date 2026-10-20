// Payment card numbers in what a user types to a chat (dgc/cards.py is the enforcement; this checks before
// sending, so it is instant). Cards follow the password rule: typed on a Pip's own screen, never in a chat, where
// they would be kept and sent to a model. 13 to 19 digits, spaces or dashes between groups (one kind per number),
// a card network's start and length, and the Luhn check: a bill, UHID, phone or bank account number is not one.
// main.js (the Work chat) carries a copy between its card-number markers; a test keeps the three the same.
function luhn(digits) {
  let total = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = Number(digits[i]) * (double ? 2 : 1); total += n > 9 ? n - 9 : n; double = !double; }
  return total % 10 === 0;
}
function network(d) {
  const n = d.length, two = Number(d.slice(0, 2)), three = Number(d.slice(0, 3)), four = Number(d.slice(0, 4));
  return (d[0] === '4' && [13, 16, 19].includes(n)) || ((two >= 51 && two <= 55 || four >= 2221 && four <= 2720) && n === 16)
    || ([34, 37].includes(two) && n === 15) || (([36, 38, 39].includes(two) || three >= 300 && three <= 305) && n >= 14 && n <= 19)
    || ((four === 6011 || two === 65 || three >= 644 && three <= 649) && n >= 16 && n <= 19)
    || (([60, 81, 82].includes(two) || [353, 356, 508].includes(three)) && n === 16)
    || (four >= 3528 && four <= 3589 && n >= 16 && n <= 19) || ((two >= 56 && two <= 58 || [62, 63, 67].includes(two)) && n >= 16 && n <= 19);
}
/** The first payment card number in text (its digits), or null. */
export function cardNumber(text) {
  for (const match of String(text || '').slice(0, 100000).matchAll(/\d+(?:[ -]\d+)*/g)) {
    const parts = match[0].split(/([ -])/), groups = parts.filter((_, i) => i % 2 === 0), seps = parts.filter((_, i) => i % 2 === 1);
    for (let start = 0; start < Math.min(groups.length, 64); start++) {
      let digits = ''; const used = new Set();
      for (let end = start; end < groups.length; end++) {
        if (end > start) used.add(seps[end - 1]);
        digits += groups[end];
        if (digits.length > 19 || used.size > 1) break;
        if (digits.length >= 13 && network(digits) && luhn(digits)) return digits;
      }
    }
  }
  return null;
}
