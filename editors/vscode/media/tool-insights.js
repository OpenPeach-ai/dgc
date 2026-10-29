// Small, deterministic summaries beside the raw tool output. No model HTML is accepted here.
(() => {
  "use strict";
  function testCounts(output) {
    const text = String(output || "").slice(-16000);
    if (!text || text.length > 16000) return null;
    const tap = Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|skipped)\s+(\d+)\s*$/gm)]
      .map((match) => [match[1], Number(match[2])]));
    if (Number.isSafeInteger(tap.tests) && Number.isSafeInteger(tap.pass)) {
      return { total: tap.tests, passed: tap.pass, failed: tap.fail || 0, skipped: tap.skipped || 0 };
    }
    const unittest = /Ran (\d+) tests? in [\d.]+s[\s\S]{0,800}?(?:\nOK(?: \(skipped=(\d+)\))?|\nFAILED \(failures=(\d+)(?:, errors=(\d+))?(?:, skipped=(\d+))?\))/m.exec(text);
    if (unittest) {
      const total = Number(unittest[1]), skipped = Number(unittest[2] || unittest[5] || 0);
      const failed = Number(unittest[3] || 0) + Number(unittest[4] || 0);
      return { total, passed: Math.max(0, total - skipped - failed), failed, skipped };
    }
    const lines = text.split("\n").filter((line) => /\b(?:passed|failed|skipped)\b/i.test(line));
    for (const line of lines.slice(-8).reverse()) {
      if (line.length > 300 || !/\b\d+\s+(?:passed|failed|skipped)\b/i.test(line)) continue;
      const counts = { passed: 0, failed: 0, skipped: 0 };
      for (const match of line.matchAll(/\b(\d+)\s+(passed|failed|skipped)\b/gi)) counts[match[2].toLowerCase()] = Number(match[1]);
      const total = counts.passed + counts.failed + counts.skipped;
      if (total > 0 && total <= 1_000_000) return { total, ...counts };
    }
    return null;
  }
  window.DgcToolInsights = Object.freeze({ testCounts });
})();
