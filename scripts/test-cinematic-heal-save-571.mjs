// #571 — a black ★ ("cross saber") should heal a unit it can actually SAVE, not
// the most-damaged one. Reporter: 1 TIE @2dmg + 2 TIEs @1dmg, one black ★ (TIE
// health=1). The old "most-damaged first" default healed the 2-dmg TIE (2→1,
// still dead), wasting it; all three died. Now suggestHealAllocation saves a
// 1-dmg TIE (1→0). Tests the real exported engine helper directly.
// Run: node scripts/test-cinematic-heal-save-571.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
dirname(fileURLToPath(import.meta.url));
const { register } = await import('tsx/esm/api'); register();
const combat = await import('../src/engine/combat.ts');
const { suggestHealAllocation } = combat;
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const total = (s) => s.reduce((a, x) => a + x.amount, 0);

console.log('[ #571 — ★-heal saves a savable unit, not the doomed one ]');

// The reporter's case: three 1-health TIEs (black), one @2 two @1, one black ★.
{
  const cands = [
    { instanceId: 'tie-a', color: 'black', damage: 2, health: 1 },
    { instanceId: 'tie-b', color: 'black', damage: 1, health: 1 },
    { instanceId: 'tie-c', color: 'black', damage: 1, health: 1 },
  ];
  const s = suggestHealAllocation(cands, { red: 0, black: 1 });
  check('spends exactly the 1 ★', total(s) === 1);
  check('heals a 1-damage TIE (savable), NOT the 2-damage one',
    s.length === 1 && s[0].amount === 1 && (s[0].instanceId === 'tie-b' || s[0].instanceId === 'tie-c'),
    JSON.stringify(s));
}

// Two ★: should save the two 1-damage TIEs (2 units saved) rather than dump both
// into the 2-damage one.
{
  const cands = [
    { instanceId: 'tie-a', color: 'black', damage: 2, health: 1 },
    { instanceId: 'tie-b', color: 'black', damage: 1, health: 1 },
    { instanceId: 'tie-c', color: 'black', damage: 1, health: 1 },
  ];
  const s = suggestHealAllocation(cands, { red: 0, black: 2 });
  const ids = new Set(s.map((x) => x.instanceId));
  check('2 ★ save both 1-damage TIEs', total(s) === 2 && ids.has('tie-b') && ids.has('tie-c') && !ids.has('tie-a'), JSON.stringify(s));
}

// A doomed 3-health ship needing 2 ★ to survive gets fully healed when it's the
// only savable option and the budget covers it.
{
  const cands = [
    { instanceId: 'small', color: 'red', damage: 1, health: 3 }, // toSave = -1 (already survives)
    { instanceId: 'cruiser', color: 'red', damage: 3, health: 2 }, // toSave = 2 → needs both ★ to survive
  ];
  const s = suggestHealAllocation(cands, { red: 2, black: 0 });
  const cruiser = s.find((x) => x.instanceId === 'cruiser');
  check('spends both ★ to save the doomed 3/2 cruiser', total(s) === 2 && cruiser && cruiser.amount === 2, JSON.stringify(s));
}

// Nothing savable → still spends (harmless carry-over relief), most-damaged first.
{
  const cands = [
    { instanceId: 'x', color: 'black', damage: 3, health: 1 }, // toSave = 3, only 1 ★ → unsavable
    { instanceId: 'y', color: 'black', damage: 2, health: 1 }, // toSave = 2 → unsavable with 1 ★
  ];
  const s = suggestHealAllocation(cands, { red: 0, black: 1 });
  check('with nothing savable, spills onto the most-damaged unit', total(s) === 1 && s[0].instanceId === 'x', JSON.stringify(s));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
