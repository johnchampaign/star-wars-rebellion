// RoE p.2 "Choosing Mission Sets": the Rebel and Imperial player each choose
// their mission set INDEPENDENTLY and may differ (one on base, one on RoE).
// Verifies the per-side roeMissions{Rebel,Empire} toggles drive each side's
// regular mission deck separately, that "both"-set (leader-icon) cards stay in
// regardless, and that the shared `roeMissions` flag still works as the default.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

// Membership classifier — mirrors setup.ts `membership`.
const membership = (m) => m.missionSet ? m.missionSet : (m.set === 'rote' ? 'rote' : (m.leaderPortrait ? 'both' : 'base'));

// Regular (non-starting, non-project) cards actually IN a side's deck+hand,
// classified by set. Returns { rote, base, both } counts.
function deckSets(G, side) {
  const cat = G.catalog.missions;
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const ids = [...(f.missionDeck || []), ...(f.missionHand || [])];
  const out = { rote: 0, base: 0, both: 0, starting: 0 };
  for (const id of ids) {
    const m = cat[id];
    if (!m) continue;
    if (m.isStarting) { out.starting++; continue; } // starting always in — ignore for set test
    out[membership(m)]++;
  }
  return out;
}

function game(rebelRoe, empireRoe) {
  return createGame(data, { seed: 5, expansion: {
    enabled: true, roeUnits: true, cinematicCombat: false,
    roeMissionsRebel: rebelRoe, roeMissionsEmpire: empireRoe,
  } });
}

console.log('Per-side mission sets (RoE p.2):');

// 1. Rebel on RoE, Empire on base — the asymmetric case that RAW allows.
{
  const G = game(true, false);
  const r = deckSets(G, 'Rebel'), e = deckSets(G, 'Empire');
  check('Rebel=RoE has ≥1 Vader-icon (rote) regular mission', r.rote > 0, JSON.stringify(r));
  check('Rebel=RoE has NO base-only regular missions', r.base === 0, JSON.stringify(r));
  check('Empire=base has ≥1 base regular mission', e.base > 0, JSON.stringify(e));
  check('Empire=base has NO rote regular missions', e.rote === 0, JSON.stringify(e));
  check('Both sides keep leader-icon "both" cards', r.both > 0 && e.both > 0, `r=${r.both} e=${e.both}`);
}

// 2. Mirror: Rebel on base, Empire on RoE.
{
  const G = game(false, true);
  const r = deckSets(G, 'Rebel'), e = deckSets(G, 'Empire');
  check('Rebel=base has NO rote regular missions', r.rote === 0, JSON.stringify(r));
  check('Empire=RoE has ≥1 rote regular mission', e.rote > 0, JSON.stringify(e));
  check('Empire=RoE has NO base-only regular missions', e.base === 0, JSON.stringify(e));
}

// 3. Both RoE — both decks are the RoE set.
{
  const G = game(true, true);
  const r = deckSets(G, 'Rebel'), e = deckSets(G, 'Empire');
  check('Both=RoE: both have rote, neither has base-only', r.rote > 0 && e.rote > 0 && r.base === 0 && e.base === 0,
    `r=${JSON.stringify(r)} e=${JSON.stringify(e)}`);
}

// 4. Both base — both decks are the base set.
{
  const G = game(false, false);
  const r = deckSets(G, 'Rebel'), e = deckSets(G, 'Empire');
  check('Both=base: both have base, neither has rote', r.base > 0 && e.base > 0 && r.rote === 0 && e.rote === 0,
    `r=${JSON.stringify(r)} e=${JSON.stringify(e)}`);
}

// 5. Back-compat: the shared `roeMissions` flag (no per-side override) still
//    drives both sides.
{
  const on = createGame(data, { seed: 5, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const off = createGame(data, { seed: 5, expansion: { enabled: true, roeUnits: true, roeMissions: false } });
  const onR = deckSets(on, 'Rebel'), onE = deckSets(on, 'Empire');
  const offR = deckSets(off, 'Rebel'), offE = deckSets(off, 'Empire');
  check('shared roeMissions:true → both sides RoE', onR.rote > 0 && onE.rote > 0 && onR.base === 0 && onE.base === 0,
    `r=${JSON.stringify(onR)} e=${JSON.stringify(onE)}`);
  check('shared roeMissions:false → both sides base', offR.base > 0 && offE.base > 0 && offR.rote === 0 && offE.rote === 0,
    `r=${JSON.stringify(offR)} e=${JSON.stringify(offE)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
