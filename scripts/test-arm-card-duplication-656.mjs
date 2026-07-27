// #656 — Secret Facility appeared THREE times at once in a reported game: twice
// in the Empire's action discard and once still armed at Ilum. Only one copy of
// the card exists. Because the reveal queue is rebuilt each Empire turn from
// whatever is still armed, that leftover entry re-offered its reveal every turn
// forever ("Secret Facility keeps triggering even after it has been used").
//
// The sequence that duplicated it is still unknown. This pins the guard that
// blocks the duplication at the one choke point where a card becomes armed,
// and — just as importantly — that the ordinary arming path still works.
//
// Run: node scripts/test-arm-card-duplication-656.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const CARD = 'secret-facility';

/** A game with the Empire holding two probes and nothing armed. */
function setup() {
  const G = createGame(data, { seed: 656, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const e = G.empire;
  e.probeHand = ['probe-ilum', 'probe-naboo'];
  e.armedActionCards = [];
  e.actionDiscard = [];
  return G;
}
const post = (G) => {
  G.pendingChoice = { kind: 'ArmCardProbePick', side: 'Empire', cardId: CARD, candidates: [...G.empire.probeHand] };
};
const blocked = (G) => G.turnLog.filter((l) => l.kind === 'arm-card-blocked');

console.log('\n[ the ordinary arming path still works ]');
{
  const G = setup();
  post(G);
  const r = phases.resolveArmCardProbePick(G, 'probe-ilum');
  check('arm accepted', r.ok, r.reason);
  check('card is armed once', (G.empire.armedActionCards ?? []).filter((a) => a.cardId === CARD).length === 1);
  check('probe was consumed', !G.empire.probeHand.includes('probe-ilum'));
  check('nothing blocked', blocked(G).length === 0);
}

console.log('\n[ #656 cannot arm a card that is already armed ]');
{
  const G = setup();
  G.empire.armedActionCards = [{ cardId: CARD, probeSystemId: 'ilum', armedAt: 3 }];
  post(G);
  const r = phases.resolveArmCardProbePick(G, 'probe-naboo');
  check('resolver did not stall the turn', r.ok, r.reason);
  check('still only ONE armed copy',
    (G.empire.armedActionCards ?? []).filter((a) => a.cardId === CARD).length === 1,
    `armed=${JSON.stringify(G.empire.armedActionCards)}`);
  check('probe was NOT consumed', G.empire.probeHand.includes('probe-naboo'));
  check('pending choice cleared (no stall)', G.pendingChoice === undefined);
  check('the block was logged for diagnosis', blocked(G).length === 1
    && blocked(G)[0].payload?.reason === 'already-armed', JSON.stringify(blocked(G)[0]?.payload));
}

console.log('\n[ #656 cannot re-arm a card already spent to the discard ]');
{
  const G = setup();
  G.empire.actionDiscard = ['early-promotion', CARD];
  post(G);
  const r = phases.resolveArmCardProbePick(G, 'probe-ilum');
  check('resolver did not stall the turn', r.ok, r.reason);
  check('nothing became armed', (G.empire.armedActionCards ?? []).length === 0,
    `armed=${JSON.stringify(G.empire.armedActionCards)}`);
  check('probe was NOT consumed', G.empire.probeHand.includes('probe-ilum'));
  check('the discard pile was not grown further',
    G.empire.actionDiscard.filter((c) => c === CARD).length === 1);
  check('the block was logged with the reason', blocked(G).length === 1
    && blocked(G)[0].payload?.reason === 'already-discarded', JSON.stringify(blocked(G)[0]?.payload));
}

console.log('\n[ the reported end state is now unreachable by arming ]');
{
  // Reproduce the report's shape as closely as the guard allows: two copies in
  // the discard AND an attempt to arm a third. The third must not stick.
  const G = setup();
  G.empire.actionDiscard = [CARD, CARD];
  post(G);
  phases.resolveArmCardProbePick(G, 'probe-ilum');
  const instances = (G.empire.armedActionCards ?? []).filter((a) => a.cardId === CARD).length
    + G.empire.actionDiscard.filter((c) => c === CARD).length;
  check('arming cannot add a further instance', instances === 2, `instances=${instances}`);
  check('no new armed entry', (G.empire.armedActionCards ?? []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
