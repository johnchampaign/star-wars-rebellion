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

console.log('');
if (failures > 0) { console.error(`REDACTION CHECK FAILED: ${failures} failure(s)`); process.exit(1); }
console.log('REDACTION CHECK PASSED — no leaks across Empire / Rebel / spectator views.');
