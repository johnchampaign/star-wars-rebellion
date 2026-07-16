// #587 — Rapid Mobilization move-units branch: the Empire gets an explainer
// notice (units moved into the hidden base; the base did NOT move; no probe
// card changes hands). Also re-verifies the branch's RAW behavior: base stays
// put, source system's probe card stays in the deck, Empire probe hand
// untouched. Run: node scripts/test-rm-move-units-notice-587.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const handlers = await import('../src/engine/handlers/index.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

handlers.registerAll();
const G = createGame(data, { seed: 587, expansion: { enabled: true, roeUnits: true } });

// Put some Rebel units in a source system the RM move can pull from.
const srcId = Object.keys(G.map.systems).find((sid) =>
  sid !== G.rebelBaseSystemId
  && !G.map.systems[sid].units.some((u) => u.side === 'Empire')
  && !(G.rebel.leadersOnBoard[sid] ?? []).length);
const src = G.map.systems[srcId];
src.units.push(
  { instanceId: 'rmT0', typeId: 'rebel-transport', side: 'Rebel', damage: 0 },
  { instanceId: 'rmT1', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 },
  { instanceId: 'rmT2', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 },
);

const baseBefore = G.rebelBaseSystemId;
const deckBefore = [...G.probeDeck];
const handBefore = [...(G.empire.probeHand ?? [])];
const srcProbe = Object.values(G.catalog.probes).find((p) => p.systemId === srcId);

// Drive the RM chain: queue -> branch(move-units) -> move pick.
G.pendingRapidMobilizations = [{ twoLeaders: false }];
G.pendingChoice = {
  kind: 'RapidMobilizationBranch', side: 'Rebel',
  twoLeaders: false, baseRevealed: false, moveUnitsAvailable: true,
};
let r = phases.resolveRapidMobilizationBranch(G, 'move-units');
check('branch(move-units) resolves', r.ok, r.reason);
r = phases.resolveRapidMobilizationMove(G, srcId, ['rmT0', 'rmT1', 'rmT2']);
check('move pick resolves', r.ok, r.reason);

check('base did NOT move', G.rebelBaseSystemId === baseBefore,
  `${baseBefore} -> ${G.rebelBaseSystemId}`);
check('units arrived in Rebel Base space',
  G.map.rebelBaseSpace.units.filter((u) => u.instanceId.startsWith('rmT')).length === 3);
check('source system emptied of the picked units',
  !src.units.some((u) => u.instanceId.startsWith('rmT')));
// After the RM queue drains, the engine proceeds into Refresh, where the
// Empire legitimately draws 2 probe cards ("launch probe droids") — so the
// deck/hand aren't byte-identical. What must hold: no card LEFT the game,
// the source system's card was not handed over as if it were an old base,
// and the base's own card stayed out of both piles.
const handNow = G.empire.probeHand ?? [];
check('only the 2 Refresh probe draws moved deck->hand',
  handNow.length === handBefore.length + 2
  && deckBefore.length === G.probeDeck.length + 2,
  `hand ${handBefore.length}->${handNow.length}, deck ${deckBefore.length}->${G.probeDeck.length}`);
check('source system probe card NOT given to the Empire (still a live candidate)',
  !srcProbe || !handNow.includes(srcProbe.id));
const baseProbe = Object.values(G.catalog.probes).find((p) => p.systemId === baseBefore);
check('base probe card still set aside (not in deck, not in Empire hand)',
  !baseProbe || (!G.probeDeck.includes(baseProbe.id) && !handNow.includes(baseProbe.id)));

const notice = (G.pendingNotices ?? []).find((n) => n.id.startsWith('rm-move-units-t'));
check('Empire explainer notice queued', !!notice);
check('notice is Empire-only', notice?.side === 'Empire', `side=${notice?.side}`);
check('notice says the base did not move',
  /did NOT move/.test(notice?.details ?? ''));
check('notice names the source system',
  (notice?.details ?? '').includes(G.catalog.systems[srcId]?.name ?? srcId));

// Zero-unit resolution (decline): no notice, still resolves.
const G2 = createGame(data, { seed: 588, expansion: { enabled: true, roeUnits: true } });
G2.pendingRapidMobilizations = [{ twoLeaders: false }];
G2.pendingChoice = {
  kind: 'RapidMobilizationBranch', side: 'Rebel',
  twoLeaders: false, baseRevealed: false, moveUnitsAvailable: true,
};
phases.resolveRapidMobilizationBranch(G2, 'move-units');
r = phases.resolveRapidMobilizationMove(G2, Object.keys(G2.map.systems)[0], []);
check('zero-unit move resolves', r.ok, r.reason);
check('no explainer notice for a zero-unit move',
  !(G2.pendingNotices ?? []).some((n) => n.id.startsWith('rm-move-units-t')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
