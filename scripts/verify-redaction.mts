// Standalone redaction proof for the online port (Phase 2). Run:
//   npx tsx scripts/verify-redaction.mts
// Builds a fixture state with known secrets and asserts the redacted views
// leak nothing. Exits non-zero on any failure (CI-gateable).

import { redactStateForViewer, HIDDEN } from '../src/adapter/redact';
import type { GameState } from '../src/engine/types';

const BASE = 'mon-calamari';
let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}`); failures++; }
}

function faction(side: 'Rebel' | 'Empire', secret: string) {
  return {
    side,
    leaderPool: ['luke'],
    leadersOnBoard: {},
    leadersOnMissions: [{ missionId: `${secret}-mission`, leaderIds: ['leia'] }],
    eliminatedLeaders: [],
    attachmentRings: [],
    actionDeck: ['adeck1', 'adeck2'],
    actionHand: [`${secret}-action`],
    actionDiscard: ['adisc'],
    missionDeck: ['mdeck1'],
    missionHand: [`${secret}-mission-hand`],
    missionDiscard: [],
    buildQueue: {},
    objectiveDeck: side === 'Rebel' ? ['odeck'] : undefined,
    objectiveHand: side === 'Rebel' ? [`${secret}-obj`] : undefined,
    objectiveDiscard: side === 'Rebel' ? [] : undefined,
    probeHand: side === 'Empire' ? [`${secret}-probe`] : undefined,
    projectDeck: side === 'Empire' ? ['pjdeck'] : undefined,
    projectDiscard: side === 'Empire' ? [] : undefined,
  };
}

const fixture = {
  rng: { state: 999_999 },
  controllerSeeds: { rebel: 7, empire: 9 },
  probeDeck: ['probe-a', 'probe-b', 'probe-c'],
  rebelBaseSystemId: BASE,
  rebelBaseRevealed: false,
  pendingRebelBasePick: ['cand-a', 'cand-b'],
  turnLog: [{ kind: 'pick-rebel-base', systemId: BASE }],
  rebel: faction('Rebel', 'REBELSECRET'),
  empire: faction('Empire', 'EMPIRESECRET'),
} as unknown as GameState;

// ---- Empire's view: must not see the base or any Rebel secret ----
console.log('Empire view:');
const e = redactStateForViewer(fixture, 'Empire');
check('base location masked', e.rebelBaseSystemId === HIDDEN);
check('setup base candidates stripped', e.pendingRebelBasePick === undefined);
check('rng zeroed', e.rng.state === 0);
check('controller seeds zeroed', e.controllerSeeds.rebel === 0 && e.controllerSeeds.empire === 0);
check('turn log emptied', e.turnLog.length === 0);
check('probe deck masked (count kept)', e.probeDeck.length === 3 && e.probeDeck.every((x) => x === HIDDEN));
check('rebel mission hand masked (count kept)', e.rebel.missionHand.length === 1 && e.rebel.missionHand.every((x) => x === HIDDEN));
check('rebel objective hand masked', (e.rebel.objectiveHand ?? []).every((x) => x === HIDDEN));
check('rebel assigned missionId masked, leaders kept',
  e.rebel.leadersOnMissions[0].missionId === HIDDEN &&
  e.rebel.leadersOnMissions[0].leaderIds[0] === 'leia');
check('own (empire) mission hand kept', e.empire.missionHand[0] === 'EMPIRESECRET-mission-hand');
check('own (empire) probe hand kept', (e.empire.probeHand ?? [])[0] === 'EMPIRESECRET-probe');
check('all decks masked even for owner', e.empire.missionDeck.every((x) => x === HIDDEN) && e.empire.actionDeck.every((x) => x === HIDDEN));
const eJson = JSON.stringify(e);
check('no base string anywhere in Empire payload', !eJson.includes(BASE));
check('no Rebel hand/mission secret in Empire payload', !eJson.includes('REBELSECRET'));

// ---- Rebel's view: keeps own secrets + base, hides Empire's ----
console.log('Rebel view:');
const r = redactStateForViewer(fixture, 'Rebel');
check('base location visible to Rebel', r.rebelBaseSystemId === BASE);
check('setup candidates visible to Rebel', JSON.stringify(r.pendingRebelBasePick) === JSON.stringify(['cand-a', 'cand-b']));
check('own (rebel) mission hand kept', r.rebel.missionHand[0] === 'REBELSECRET-mission-hand');
check('own (rebel) objective hand kept', (r.rebel.objectiveHand ?? [])[0] === 'REBELSECRET-obj');
check('empire mission hand masked', r.empire.missionHand.every((x) => x === HIDDEN));
check('empire probe hand masked', (r.empire.probeHand ?? []).every((x) => x === HIDDEN));
const rJson = JSON.stringify(r);
check('no Empire secret in Rebel payload', !rJson.includes('EMPIRESECRET'));

// ---- Spectator (null): sees no private info for either side ----
console.log('Spectator (null) view:');
const s = redactStateForViewer(fixture, null);
check('base masked for spectator', s.rebelBaseSystemId === HIDDEN);
check('both hands masked for spectator',
  s.rebel.missionHand.every((x) => x === HIDDEN) && s.empire.missionHand.every((x) => x === HIDDEN));

// ---- Purity: the original must be untouched ----
console.log('Purity:');
check('input rng unchanged', fixture.rng.state === 999_999);
check('input base unchanged', fixture.rebelBaseSystemId === BASE);
check('input rebel hand unchanged', fixture.rebel.missionHand[0] === 'REBELSECRET-mission-hand');

// ---- Real interactive-Setup state: the shape now exposed to online games ----
// (autoSetupUnits=false). Proves the live engine's Setup state doesn't leak the
// hidden base or its candidates to the Empire.
{
  const { readFile } = await import('node:fs/promises');
  const { createGame } = await import('../src/engine/setup');
  const names = ['systems','adjacency','leaders','actions','missions','objectives','tactics','probes'] as const;
  const parsed = await Promise.all(names.map(async (n) => JSON.parse(await readFile(`assets/${n}.json`, 'utf8'))));
  const [systems,adjacency,leaders,actions,missions,objectives,tactics,probes] = parsed;
  const data = { systems,adjacency,leaders,actions,missions,objectives,tactics,probes } as never;
  const g = createGame(data, { seed: 4242, autoSetupUnits: false });

  console.log('Real interactive-Setup state:');
  check('game starts in Setup phase', g.phase === 'Setup');
  check('Empire deploys first', g.currentPlayer === 'Empire');
  check('a real base + candidates exist', !!g.rebelBaseSystemId && (g.pendingRebelBasePick?.length ?? 0) > 0);

  const trueBase = g.rebelBaseSystemId as string;
  const eView = redactStateForViewer(g, 'Empire');
  check('Setup: base masked from Empire', eView.rebelBaseSystemId === HIDDEN);
  check('Setup: candidates stripped from Empire', eView.pendingRebelBasePick === undefined);
  // The base id legitimately appears as a board-map key and in the static
  // catalog (every system does — the base system is an ordinary empty neutral
  // there, indistinguishable from any other). A LEAK is the id appearing in any
  // OTHER field. Strip the two universal structures, then it must be absent.
  const eStripped = { ...(eView as Record<string, unknown>), map: undefined, catalog: undefined };
  check('Setup: base id appears in no leak-vector field for Empire', !JSON.stringify(eStripped).includes(trueBase));
  // And the base system, as the Empire sees it, carries no Rebel units that
  // would single it out (base defenders live in the location-agnostic base space).
  const baseSysForEmpire = (eView as never as { map: { systems: Record<string, { units: unknown[] }> } }).map.systems[trueBase];
  check('Setup: base system shows no Rebel units to Empire', baseSysForEmpire.units.length === 0);
  // Empire probe rule-outs are precomputed server-side (deck is hidden) and must
  // never include the actual base.
  const ruled = (eView as never as { empireProbeRuledOut?: string[] }).empireProbeRuledOut;
  check('Setup: Empire gets a probe-ruled-out list', Array.isArray(ruled));
  check('Setup: probe-ruled-out never includes the base', !ruled?.includes(trueBase));

  const rView = redactStateForViewer(g, 'Rebel');
  check('Setup: Rebel sees the true base', rView.rebelBaseSystemId === trueBase);
  check('Setup: Rebel sees the candidates', (rView.pendingRebelBasePick?.length ?? 0) > 0);
  const rRuled = (rView as never as { empireProbeRuledOut?: string[] }).empireProbeRuledOut;
  check('Setup: Rebel view gets NO empire probe rule-outs', rRuled === undefined);
}

console.log('');
if (failures > 0) { console.error(`REDACTION CHECK FAILED: ${failures} failure(s)`); process.exit(1); }
console.log('REDACTION CHECK PASSED — no leaks across Empire / Rebel / spectator views.');
