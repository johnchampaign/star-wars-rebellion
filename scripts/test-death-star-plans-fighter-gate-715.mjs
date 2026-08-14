// #715 — "Destroyed all other ships on the system with the fully constructed
// death star intending to use Death Star Plans objective card, however, combat
// continued with just the Death Star vs my fleet until my fleet was eventually
// destroyed."
//
// The reporter's mental model was "clear away every other ship, then the Plans
// become usable". The card says something different:
//
//   "If there is at least 1 FIGHTER after the space battle step, reveal this
//    card to roll 3 dice. If you roll a direct hit, play this card and destroy
//    a Death Star in this system. Otherwise return this card to your hand."
//
// So the gate is a surviving Rebel fighter (X-Wing / Y-Wing — the only two
// Rebel unit types with class 'fighter'), NOT "the Death Star is the last ship
// standing". Capital ships don't qualify no matter how many are left, and
// clearing the escorts is irrelevant if the fighters died doing it.
//
// This test exists because that distinction is invisible from a play log: the
// reported combat had already scrolled out of the 30-entry window, so the only
// way to answer the report honestly was to pin down what the engine actually
// does in each case. It also guards the #139/#146 fix, which moved the window
// to fire once per round the instant the space step resolves rather than at
// combat end — by which point the fighters that qualify you are usually dead.
//
// Run: node scripts/test-death-star-plans-fighter-gate-715.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
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

/** Combat at SYS, paused exactly at the "after the space battle step" window.
 *  `rebelUnits` is the Rebel fleet that survived to that point. */
function atSpaceStepEnd(seed, rebelUnits, { hand = ['death-star-plans-2'], deathStar = true } = {}) {
  const G = createGame(data, { seed });
  G.map.systems[SYS].units = [
    ...(deathStar ? [{ instanceId: 'ds1', typeId: 'death-star', side: 'Empire', damage: 0 }] : []),
    // A lone Death Star would end the combat outright once the Rebels are gone;
    // an escort keeps the Empire present in the ground theater too.
    { instanceId: 'st1', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
    ...rebelUnits,
  ];
  G.rebel.objectiveHand = [...hand];
  // Start-of-combat action cards would post their own choice first and mask
  // whichever choice we're actually testing for.
  G.rebel.actionHand = [];
  G.empire.actionHand = [];
  // Same for the "add a leader to this combat" prompt, which is posted from
  // beginCombat and pauses ahead of the space step. Leaving it in made the
  // negative cases pass for the WRONG reason — no window was offered because
  // combat had stopped on the leader pick, not because the fighter gate said no.
  G.rebel.leaderPool = [];
  G.empire.leaderPool = [];
  combat.beginCombat(G, 'Rebel', [SYS], SYS);
  const c = G.pendingCombat;
  if (!c) return { G, c: null };
  // Jump to the moment the card cares about: the space battle step has resolved.
  c.roundTheatersDone = ['space'];
  c.dsPlansOfferedThisRound = false;
  combat.runCombat(G);
  return { G, c };
}

const offered = (G) => G.pendingChoice?.kind === 'DeathStarPlansAttempt';
/** Whether the window was EVER posted during the whole combat, not just whether
 *  it happens to be the current choice. Needed because a combat that declines
 *  the window rolls straight on into the next round, which resets
 *  `dsPlansOfferedThisRound` — reading that flag afterwards says "never
 *  evaluated" when it was in fact evaluated and correctly declined. */
const dspEverRequested = (G) => (G.turnLog ?? []).some(
  (e) => e.kind === 'choice-request' && e.payload?.kind === 'DeathStarPlansAttempt');
/** The negative cases must fail the FIGHTER gate, not stall before reaching it. */
const stalledEarly = (G) => G.pendingChoice?.kind === 'CombatAddLeaderPick';

console.log('\n[ the card fires when a Rebel FIGHTER survives the space step ]');
{
  const { G, c } = atSpaceStepEnd(715, [{ instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 }]);
  check('combat started', !!c);
  check('the Death Star Plans window is offered', offered(G), `pendingChoice=${G.pendingChoice?.kind}`);
  check('it targets the Death Star present', (G.pendingChoice?.deathStarInstanceIds ?? []).includes('ds1'),
    JSON.stringify(G.pendingChoice?.deathStarInstanceIds));
}
{
  // Y-Wing is the other Rebel fighter — same class, must behave identically.
  const { G } = atSpaceStepEnd(716, [{ instanceId: 'yw1', typeId: 'y-wing', side: 'Rebel', damage: 0 }]);
  check('a Y-Wing qualifies too', offered(G), `pendingChoice=${G.pendingChoice?.kind}`);
}

console.log('\n[ #715 capital ships alone do NOT qualify — the reported case ]');
{
  // Exactly the reporter's situation: the escorts are gone, the Death Star is
  // the only enemy ship left, and a Rebel fleet is still in the system — but
  // every surviving Rebel ship is a capital ship.
  const { G } = atSpaceStepEnd(717, [
    { instanceId: 'cc1', typeId: 'corellian-corvette', side: 'Rebel', damage: 0 },
    { instanceId: 'rt1', typeId: 'rebel-transport', side: 'Rebel', damage: 0 },
  ]);
  check('combat reached the gate rather than stalling short of it', !stalledEarly(G),
    `pendingChoice=${G.pendingChoice?.kind}`);
  check('no window is offered without a fighter', !offered(G) && !dspEverRequested(G),
    `pendingChoice=${G.pendingChoice?.kind}`);
  check('and the card stays in the Rebel hand', (G.rebel.objectiveHand ?? []).includes('death-star-plans-2'),
    JSON.stringify(G.rebel.objectiveHand));
  // The actual complaint was silence: no prompt, no reason given. Explaining
  // beats being right quietly.
  const n = (G.pendingNotices ?? []).find((x) => x.id.startsWith('dsp-no-fighter-'));
  check('the Rebel is TOLD why the window did not open', !!n,
    JSON.stringify((G.pendingNotices ?? []).map((x) => x.id)));
  check('  …and the notice names the fighter requirement', !!n && /fighter/i.test(n.details ?? ''),
    n?.details?.slice(0, 60));
  check('  …and it is addressed to the Rebel', n?.side === 'Rebel', String(n?.side));
}
{
  // The distinction that matters: adding ONE fighter to that same fleet flips it.
  const { G } = atSpaceStepEnd(717, [
    { instanceId: 'cc1', typeId: 'corellian-corvette', side: 'Rebel', damage: 0 },
    { instanceId: 'rt1', typeId: 'rebel-transport', side: 'Rebel', damage: 0 },
    { instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 },
  ]);
  check('the same fleet WITH one fighter is offered the window', offered(G),
    `pendingChoice=${G.pendingChoice?.kind}`);
}

console.log('\n[ the other gates still hold ]');
{
  const { G } = atSpaceStepEnd(718, [{ instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 }],
    { deathStar: false });
  check('no Death Star in the system → no window', !offered(G) && !dspEverRequested(G), `pendingChoice=${G.pendingChoice?.kind}`);
  check('  …and it reached the gate to decide that', !stalledEarly(G), `pendingChoice=${G.pendingChoice?.kind}`);
  // No Death Star means the card was never relevant here — explaining the
  // fighter rule would be noise in an ordinary fleet battle.
  check('  …and no "no fighter" notice is raised without a Death Star',
    !(G.pendingNotices ?? []).some((x) => x.id.startsWith('dsp-no-fighter-')),
    JSON.stringify((G.pendingNotices ?? []).map((x) => x.id)));
}
{
  const { G } = atSpaceStepEnd(719, [{ instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 }],
    { hand: ['seize-control-2'] });
  check('card not in hand → no window', !offered(G) && !dspEverRequested(G), `pendingChoice=${G.pendingChoice?.kind}`);
  check('  …and it reached the gate to decide that', !stalledEarly(G), `pendingChoice=${G.pendingChoice?.kind}`);
}
{
  // RoE Secure the Plans: "While the marker remains, Rebels cannot play Death
  // Star Plans."
  const { G } = atSpaceStepEnd(720, [{ instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 }]);
  check('sanity: that seed DOES offer without the marker', offered(G));
}
{
  const G0 = createGame(data, { seed: 721 });
  G0.map.systems[SYS].units = [
    { instanceId: 'ds1', typeId: 'death-star', side: 'Empire', damage: 0 },
    { instanceId: 'st1', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
    { instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 },
  ];
  G0.rebel.objectiveHand = ['death-star-plans-2'];
  G0.rebel.actionHand = []; G0.empire.actionHand = [];
  G0.rebel.leaderPool = []; G0.empire.leaderPool = [];
  const anySys = Object.keys(G0.map.systems)[0];
  G0.map.systems[anySys].targetMarkers = [
    ...(G0.map.systems[anySys].targetMarkers ?? []), { source: 'secure-the-plans' },
  ];
  combat.beginCombat(G0, 'Rebel', [SYS], SYS);
  const c0 = G0.pendingCombat;
  if (c0) { c0.roundTheatersDone = ['space']; c0.dsPlansOfferedThisRound = false; combat.runCombat(G0); }
  check('Secure the Plans marker blocks the window', !offered(G0) && !dspEverRequested(G0), `pendingChoice=${G0.pendingChoice?.kind}`);
  check('  …and it reached the gate to decide that', !stalledEarly(G0), `pendingChoice=${G0.pendingChoice?.kind}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
