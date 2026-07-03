// Online per-seat mission set (RoE p.2): rebuildMissionDeck re-derives ONE
// side's regular mission deck + starting hand for a chosen set and locks that
// seat's choice, WITHOUT touching the opponent, the project deck, or anything
// else. Backs the async-PvP flow where each human seat picks on first entry.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame, rebuildMissionDeck } = await import('../src/engine/setup.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const membership = (m) => m.missionSet ? m.missionSet : (m.set === 'rote' ? 'rote' : (m.leaderPortrait ? 'both' : 'base'));
function deckSets(G, side) {
  const cat = G.catalog.missions;
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const out = { rote: 0, base: 0, both: 0, starting: 0 };
  for (const id of [...(f.missionDeck || []), ...(f.missionHand || [])]) {
    const m = cat[id]; if (!m) continue;
    if (m.isStarting) { out.starting++; continue; }
    out[membership(m)]++;
  }
  return out;
}
// A stable, deterministic online-style game (expansion on, both sides RoE by default).
const newGame = () => createGame(data, { seed: 42, autoSetupUnits: false,
  expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });

console.log('Online per-seat mission set (rebuildMissionDeck):');

// 1. Rebuild Rebel to base while Empire stays RoE — the asymmetric target case.
{
  const G = newGame();
  const empBefore = JSON.stringify({ d: G.empire.missionDeck, h: G.empire.missionHand });
  const projBefore = JSON.stringify(G.empire.projectDeck);
  rebuildMissionDeck(G, 'Rebel', /* useRoe */ false, 12345);
  const r = deckSets(G, 'Rebel'), e = deckSets(G, 'Empire');
  check('Rebel switched to base (no rote regulars)', r.rote === 0 && r.base > 0, JSON.stringify(r));
  check('Empire untouched — still RoE', e.rote > 0 && e.base === 0, JSON.stringify(e));
  check('Empire mission deck+hand byte-identical', JSON.stringify({ d: G.empire.missionDeck, h: G.empire.missionHand }) === empBefore);
  check('Empire project deck untouched', JSON.stringify(G.empire.projectDeck) === projBefore);
  check('lock set for Rebel only', G.expansion.missionSetLocked?.Rebel === true && !G.expansion.missionSetLocked?.Empire,
    JSON.stringify(G.expansion.missionSetLocked));
  check('roeMissionsRebel flipped to false', G.expansion.roeMissionsRebel === false);
  check('Rebel still holds its always-in starting missions', r.starting > 0, JSON.stringify(r));
}

// 2. Rebuild Empire to base (mirror), Rebel stays RoE.
{
  const G = newGame();
  rebuildMissionDeck(G, 'Empire', false, 999);
  const r = deckSets(G, 'Rebel'), e = deckSets(G, 'Empire');
  check('Empire switched to base', e.rote === 0 && e.base > 0, JSON.stringify(e));
  check('Rebel still RoE', r.rote > 0 && r.base === 0, JSON.stringify(r));
  check('lock set for Empire only', G.expansion.missionSetLocked?.Empire === true && !G.expansion.missionSetLocked?.Rebel);
}

// 3. Rebuild to the SAME set still locks (idempotent confirm) and stays valid.
{
  const G = newGame();
  rebuildMissionDeck(G, 'Rebel', true, 7);
  const r = deckSets(G, 'Rebel');
  check('confirming RoE keeps RoE + locks', r.rote > 0 && r.base === 0 && G.expansion.missionSetLocked?.Rebel === true, JSON.stringify(r));
}

// 4. Deterministic in seed: same seed → identical rebuilt deck; different seed → (very likely) different order.
{
  const A = newGame(); rebuildMissionDeck(A, 'Rebel', true, 555);
  const B = newGame(); rebuildMissionDeck(B, 'Rebel', true, 555);
  const C = newGame(); rebuildMissionDeck(C, 'Rebel', true, 556);
  check('same seed → identical deck', JSON.stringify(A.rebel.missionDeck) === JSON.stringify(B.rebel.missionDeck));
  check('different seed → different order', JSON.stringify(A.rebel.missionDeck) !== JSON.stringify(C.rebel.missionDeck));
}

// 5. Hand shape preserved: starting missions + exactly 2 drawn (matches createGame).
{
  const G = newGame();
  const before = newGame(); // same seed, untouched, to compare hand size shape
  rebuildMissionDeck(G, 'Rebel', false, 1);
  const startingCount = Object.values(G.catalog.missions).filter((m) => m.side === 'Rebel' && m.isStarting && !m.isProject).length;
  check('Rebel hand = (owned starting) + 2 draws', G.rebel.missionHand.length === startingCount + 2,
    `hand=${G.rebel.missionHand.length} starting=${startingCount}`);
  void before;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
