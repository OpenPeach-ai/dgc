import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageLog } from '../sdk/typescript/src/usage.ts';

test('long SDK usage logs keep full totals and only the last 500 safe rows', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dgc-sdk-usage-ts-'));
  try {
    const log = new UsageLog(join(scratch, 'state'));
    const lines = Array.from({ length: 1200 }, (_, i) => JSON.stringify({
      ts: i + 1, id: i, department: i % 2 ? 'b' : 'a', input_tokens: 1,
      output_tokens: 2, cost_usd: .01,
    }));
    lines.push(JSON.stringify({ ts: 'broken', input_tokens: 99999, output_tokens: 99999 }));
    lines.push(JSON.stringify({ ts: 1201, input_tokens: 99999, output_tokens: 99999,
      padding: 'x'.repeat(1024 * 1024) }));
    lines.push(JSON.stringify({ ts: 1202, id: 'unknown', department: 'a',
      input_tokens: null, output_tokens: null }));
    writeFileSync(log.path, lines.join('\n') + '\n');
    const report = log.query();
    assert.deepEqual([report.runs, report.unknownUsageRuns], [1201, 1]);
    assert.deepEqual([report.inputTokens, report.outputTokens, report.costUsd], [1200, 2400, 12]);
    assert.deepEqual([report.rows.length, report.rows[0].id, report.rows.at(-1).id], [500, 701, 'unknown']);
    assert.deepEqual(report.byDepartment.map((item) => item.runs), [601, 600]);
    assert.equal(log.query({ department: 'b' }).runs, 600);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
