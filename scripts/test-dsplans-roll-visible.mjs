// "I would like to see the roll results of Death Star Plans objective, without
// checking the log." — Verkan, BGG.
//
// He was right that there was nowhere else to look. finalizeDsPlans logged
// death-star-plans-success / -miss / -blocked-by-shield-bunker /
// -blocked-by-target-marker, each carrying the three faces, and that was the
// ONLY record. The attempt modal appears before the roll; nothing reported what
// the dice actually did. So the single most dramatic roll in the game — the one
// that either kills the Death Star or doesn't — resolved in silence.
//
// All four outcomes now raise a notice naming the faces. This test pins each
// one, because a missing notice is invisible: the game still plays correctly,
// the player just doesn't find out what happened, which is exactly the state
// that prompted the report.
//
// Run: node scripts/test-dsplans-roll-visible.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const SYS = 'corellia';

/** A pending Death Star Plans attempt at SYS. `extra` drops in a Shield Bunker
 *  or a Secure the Plans marker for the two blocked paths. */
function setup(seed, { bunker = false, marker = false } = {}) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true } });
  G.map.systems[SYS].units = [
    { instanceId: 'ds1', typeId: 'death-star', side: 'Empire', damage: 0 },
    { instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 },
    ...(bunker ? [{ instanceId: 'sb1', typeId: 'shield-bunker', side: 'Empire', damage: 0 }] : []),
  ];
  G.rebel.objectiveHand = ['death-star-plans-2'];
  // Isolate the roll: no One-in-a-Million, no Yoda ring offer.
  G.rebel.actionHand = (G.rebel.actionHand ?? []).filter((c) => c !== 'one-in-a-million');
  G.yodaRerollUsedThisRound = true;
  if (marker) M.addTargetMarker?.(G, SYS, 'secure-the-plans');
  G.pendingChoice = {
    kind: 'DeathStarPlansAttempt', side: 'Rebel',
    objectiveId: 'death-star-plans-2', systemId: SYS, deathStarInstanceIds: ['ds1'],
  };
  return G;
}

const notice = (G) => (G.pendingNotices ?? []).find((n) => n.id.startsWith('dsp-roll-'));
const lastLog = (G, kind) => (G.turnLog ?? []).filter((e) => e.kind === kind).pop();

// Scan seeds until each outcome shows up — the roll is random, so we can't pick
// hit/miss directly without reaching into the dice.
console.log('\n[ every resolved roll reports its faces to the player ]');
{
  let sawHit = false, sawMiss = false;
  for (let seed = 1; seed <= 120 && !(sawHit && sawMiss); seed++) {
    const G = setup(seed);
    const r = combat.resolveDeathStarPlansAttempt(G, true, 'ds1');
    if (!r.ok) continue;
    if (G.dsPlansAttempt) continue; // paused for a reroll offer — not a final result
    const success = lastLog(G, 'death-star-plans-success');
    const miss = lastLog(G, 'death-star-plans-miss');
    const n = notice(G);
    if (success && !sawHit) {
      sawHit = true;
      check('a DIRECT HIT is reported', !!n, 'no dsp-roll notice');
      check('  …the notice names the outcome', !!n && /direct hit/i.test(n.title), n?.title);
      check('  …and shows all three faces', !!n && (n.details.match(/[✶✓◈·]/g) ?? []).length >= 3,
        n?.details?.slice(0, 90));
      check('  …and it is addressed to the Rebel', n?.side === 'Rebel', String(n?.side));
    }
    if (miss && !sawMiss) {
      sawMiss = true;
      check('a MISS is reported', !!n, 'no dsp-roll notice');
      check('  …the notice says no direct hit', !!n && /no direct hit/i.test(n.title), n?.title);
      check('  …and shows all three faces', !!n && (n.details.match(/[✶✓◈·]/g) ?? []).length >= 3,
        n?.details?.slice(0, 90));
      check('  …and says the card comes back', !!n && /returns to/i.test(n.details));
    }
  }
  check('the seed scan found both a hit and a miss', sawHit && sawMiss, `hit=${sawHit} miss=${sawMiss}`);
}

console.log('\n[ a direct hit stopped by a Shield Bunker is explained, not silent ]');
{
  // The cruellest case: the player rolls the ✶ they needed and nothing happens.
  let checked = false;
  for (let seed = 1; seed <= 200 && !checked; seed++) {
    const G = setup(seed, { bunker: true });
    const r = combat.resolveDeathStarPlansAttempt(G, true, 'ds1');
    if (!r.ok || G.dsPlansAttempt) continue;
    if (!lastLog(G, 'death-star-plans-blocked-by-shield-bunker')) continue;
    checked = true;
    const n = notice(G);
    check('the blocked direct hit is reported', !!n, 'no dsp-roll notice');
    check('  …and the notice blames the Shield Bunker', !!n && /shield bunker/i.test(n.title + n.details),
      n?.title);
    check('  …and the Death Star is still there',
      G.map.systems[SYS].units.some((u) => u.typeId === 'death-star'));
  }
  check('the scan found a bunker-blocked direct hit', checked, 'no direct hit rolled in 200 seeds');
}

console.log('\n[ declining the attempt reports nothing — no phantom roll ]');
{
  const G = setup(5);
  const r = combat.resolveDeathStarPlansAttempt(G, false);
  check('the decline resolved', r.ok === true, JSON.stringify(r));
  check('no roll notice is raised when no dice were thrown', !notice(G),
    JSON.stringify((G.pendingNotices ?? []).map((x) => x.id)));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
