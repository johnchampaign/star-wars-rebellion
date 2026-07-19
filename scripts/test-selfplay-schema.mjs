// Tests for the self-play JSONL schema (selfplay-v1): a valid record passes,
// each required-field violation is caught, buildRecord throws loudly, and
// readJsonl skips garbage without dying.
// Run: node scripts/test-selfplay-schema.mjs
import { validateRecord, buildRecord, readJsonl } from './selfplay/lib/schema.mjs';
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const good = () => ({
  schema: 'selfplay-v1', game: 'rebellion', seed: 42,
  policies: { Rebel: 'heuristic', Empire: 'heuristic' },
  winner: 'Rebel', winReason: 'reputation-time', rounds: 9, durationMs: 150,
  actions: [{ t: 1, side: 'Rebel', kind: 'reveal', id: 'sabotage', target: 'mustafar' }],
  snapshots: [{ t: 1, rebel: [1, 2], empire: [1, 2] }],
  dims: { loyaltyPerRound: 0.5 },
});

console.log('[ validateRecord ]');
check('valid record passes', validateRecord(good()).length === 0, validateRecord(good()).join('; '));
check('null fails', validateRecord(null).length > 0);
for (const field of ['schema', 'game', 'seed', 'winner', 'rounds', 'actions', 'snapshots', 'dims']) {
  const rec = good();
  delete rec[field];
  check(`missing ${field} caught`, validateRecord(rec).some((p) => p.includes(field)));
}
{
  const rec = good();
  rec.schema = 'selfplay-v0';
  check('wrong schema version caught', validateRecord(rec).length > 0);
}
{
  const rec = good();
  rec.actions = [{ side: 'Rebel', kind: 'reveal' }]; // missing t
  check('malformed action caught', validateRecord(rec).length > 0);
}
{
  const rec = good();
  rec.dims = { broken: NaN };
  check('non-finite dim caught', validateRecord(rec).length > 0);
}

console.log('\n[ buildRecord ]');
{
  const { schema, ...rest } = good();
  const rec = buildRecord(rest);
  check('buildRecord stamps schema + validates', rec.schema === 'selfplay-v1');
  let threw = false;
  try { buildRecord({ game: 'rebellion' }); } catch { threw = true; }
  check('buildRecord throws on invalid', threw);
}

console.log('\n[ readJsonl ]');
{
  const text = [
    JSON.stringify(good()),
    'this is not json',
    JSON.stringify({ schema: 'selfplay-v1' }), // invalid record
    '',
    JSON.stringify(good()),
  ].join('\n');
  const { records, skipped } = readJsonl(text);
  check('reads 2 valid records', records.length === 2, String(records.length));
  check('skips 2 bad lines (blank ignored)', skipped === 2, String(skipped));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
