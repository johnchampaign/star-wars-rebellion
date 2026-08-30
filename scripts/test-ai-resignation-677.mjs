// @timeout 120000
// #677 — "do we want an AI concede at all?" John's design (2026-08-30):
//
//   "I suppose if the game is hopeless, the AI could offer the player the
//    choice. Something like 'I'm convinced I'm going to lose this game, will
//    you accept my resignation or do you want to play it out?'"
//
// The AI OFFERS, the human DECIDES. Accepting ends the game as a human win
// (winReason 'resignation'); declining is final for that game. Not RAW — the
// printed game has no surrender — so the engine only supplies the ending
// (phases.resignGame) and the judgment lives in src/play/aiResign.ts.
//
// THE HARD REQUIREMENT: never offer from a winnable position. The detector is
// structural (no eval-score thresholds), reads only the Empire's PUBLIC
// knowledge of the base location (mctsAI.baseCandidates — probe cards in hand
// and searched rule-outs, never the true base), and was validated against the
// full uploaded-game archive before shipping:
//   - 21 games the AI went on to WIN: 0 fires at any round start.
//   - 398 human wins: fires in 67 (16.8%), at the final round-start —
//     sparing the human the last dead round of play.
// (That sweep needs logs/, which is gitignored; this file pins the behavior on
// synthetic boards instead so it runs anywhere.)
//
// Run: node scripts/test-ai-resignation-677.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { hopelessFor } = await import('../src/play/aiResign.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** Late-game board, empty map, configurable markers. */
function board({ time = 8, rep = 9 } = {}) {
  const G = createGame(data, { seed: 11, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.timeMarker = time; G.reputationMarker = rep;
  return G;
}
const put = (G, sid, side, typeId) =>
  G.map.systems[sid].units.push({ instanceId: `${side}-${typeId}-${G.turnLog.length}-${G.map.systems[sid].units.length}`, typeId, side, damage: 0 });

/** A far-apart system pair for reachability cases. */
function farPair(G) {
  const ids = Object.keys(G.map.systems);
  const adjacency = G.catalog.adjacency;
  const bfs = (o) => { const d = new Map([[o, 0]]); const q = [o];
    while (q.length) { const c = q.shift(); for (const nb of adjacency[c] ?? []) if (!d.has(nb)) { d.set(nb, d.get(c) + 1); q.push(nb); } } return d; };
  let best = null;
  for (const a of ids) { const d = bfs(a);
    for (const b of ids) { const h = d.get(b);
      if (h !== undefined && (!best || h > best.hops)) best = { a, b, hops: h }; } }
  return best;
}

console.log('\n[ the engine ending: resignGame ]');
{
  const G = board();
  const r = phases.resignGame(G, 'Empire', ['test-reason']);
  check('resigning ends the game', r.ok && G.isGameOver && G.phase === 'GameOver');
  check('as a win for the OTHER side', G.winner === 'Rebel');
  check('with winReason resignation', G.winReason === 'resignation');
  check('and an audit log carrying the reasons',
    (G.turnLog ?? []).some((e) => e.kind === 'resignation' && (e.payload?.reasons ?? []).includes('test-reason')));
  check('a finished game refuses a second resignation', !phases.resignGame(G, 'Rebel').ok);
}

console.log('\n[ Empire: hopeless when nothing can reach the base in time ]');
{
  // Base revealed, one round on the clock, the only Imperial ground sits at
  // the far end of the map. No path -> hopeless.
  const G = board({ time: 8, rep: 9 }); // left = 1
  const pair = farPair(G);
  G.rebelBaseRevealed = true; G.rebelBaseSystemId = pair.a;
  put(G, pair.b, 'Empire', 'stormtrooper');
  put(G, pair.a, 'Rebel', 'rebel-trooper');
  const v = hopelessFor(G, 'Empire');
  check(`ground ${pair.hops} hops away with 1 round left is hopeless`, v.hopeless, JSON.stringify(v));
  check('and the reasons say why', v.reasons.includes('cannot-reach-base-in-time'), JSON.stringify(v.reasons));

  // NON-VACUOUS mirror: same board, ground ADJACENT to the base -> play on.
  const G2 = board({ time: 8, rep: 9 });
  G2.rebelBaseRevealed = true; G2.rebelBaseSystemId = pair.a;
  const adj = (G2.catalog.adjacency[pair.a] ?? [])[0];
  put(G2, adj, 'Empire', 'stormtrooper');
  put(G2, pair.a, 'Rebel', 'rebel-trooper');
  check('the SAME board with ground adjacent to the base is NOT hopeless',
    !hopelessFor(G2, 'Empire').hopeless);

  // A Death Star counts as a delivery asset (base-destroyed path).
  const G3 = board({ time: 8, rep: 9 });
  G3.rebelBaseRevealed = true; G3.rebelBaseSystemId = pair.a;
  put(G3, adj, 'Empire', 'death-star');
  put(G3, pair.a, 'Rebel', 'rebel-trooper');
  check('an adjacent Death Star keeps the game alive (base-destroyed path)',
    !hopelessFor(G3, 'Empire').hopeless);
}

console.log('\n[ Empire: total annihilation is hopeless outright ]');
{
  const G = board({ time: 7, rep: 10 }); // left = 3 <= 4
  G.rebelBaseRevealed = true; G.rebelBaseSystemId = Object.keys(G.map.systems)[0];
  put(G, G.rebelBaseSystemId, 'Rebel', 'rebel-trooper');
  const v = hopelessFor(G, 'Empire');
  check('no Imperial ground or Death Star anywhere -> hopeless', v.hopeless, JSON.stringify(v));
  check('reason: no-force-left', v.reasons.includes('no-force-left'), JSON.stringify(v.reasons));
}

console.log('\n[ the guards that keep it conservative ]');
{
  const pairG = board({ time: 8, rep: 9 });
  const pair = farPair(pairG);
  // Same hopeless shape, but EARLY game -> never.
  const G = board({ time: 3, rep: 14 });
  G.rebelBaseRevealed = true; G.rebelBaseSystemId = pair.a;
  put(G, pair.b, 'Empire', 'stormtrooper');
  put(G, pair.a, 'Rebel', 'rebel-trooper');
  check('never fires before turn 5, however bad the board', !hopelessFor(G, 'Empire').hopeless);

  // Plenty of clock -> never (left > 4).
  const G2 = board({ time: 6, rep: 14 });
  G2.rebelBaseRevealed = true; G2.rebelBaseSystemId = pair.a;
  put(G2, pair.b, 'Empire', 'stormtrooper');
  put(G2, pair.a, 'Rebel', 'rebel-trooper');
  check('never fires with more than 4 rounds on the clock', !hopelessFor(G2, 'Empire').hopeless);

  // Hidden base: reachability is judged against EVERY candidate, so a garrison
  // near any un-ruled-out system keeps the game alive.
  const G3 = board({ time: 8, rep: 10 });
  G3.rebelBaseRevealed = false;
  put(G3, pair.b, 'Empire', 'stormtrooper');
  check('hidden base with a garrison near candidates is NOT hopeless',
    !hopelessFor(G3, 'Empire').hopeless);

  // A finished game never offers.
  const G4 = board({ time: 8, rep: 9 });
  G4.isGameOver = true;
  check('a finished game is never "hopeless"', !hopelessFor(G4, 'Empire').hopeless);
}

console.log('\n[ Rebel: resigns only from a truly overrun base ]');
{
  const G = board({ time: 6, rep: 12 }); // rep win far away
  const sid = Object.keys(G.map.systems)[0];
  G.rebelBaseRevealed = true; G.rebelBaseSystemId = sid;
  put(G, sid, 'Rebel', 'rebel-trooper');            // garrison health 1
  for (let i = 0; i < 4; i++) put(G, sid, 'Empire', 'at-at');  // overwhelming ground
  for (let i = 0; i < 3; i++) put(G, sid, 'Empire', 'star-destroyer'); // fleet dominance
  const v = hopelessFor(G, 'Rebel');
  check('revealed + overrun + no fleet + rep far -> hopeless', v.hopeless, JSON.stringify(v));

  // NON-VACUOUS mirrors: flip each leg and it must play on.
  const G2 = board({ time: 6, rep: 12 });
  G2.rebelBaseRevealed = false;
  check('hidden base -> never', !hopelessFor(G2, 'Rebel').hopeless);

  const G3 = board({ time: 6, rep: 8 }); // left = 2: about to WIN on reputation
  G3.rebelBaseRevealed = true; G3.rebelBaseSystemId = sid;
  put(G3, sid, 'Rebel', 'rebel-trooper');
  for (let i = 0; i < 4; i++) put(G3, sid, 'Empire', 'at-at');
  for (let i = 0; i < 3; i++) put(G3, sid, 'Empire', 'star-destroyer');
  check('about to win on reputation -> never, even overrun', !hopelessFor(G3, 'Rebel').hopeless);

  const G4 = board({ time: 6, rep: 12 });
  G4.rebelBaseRevealed = true; G4.rebelBaseSystemId = sid;
  for (let i = 0; i < 5; i++) put(G4, sid, 'Rebel', 'rebel-trooper'); // real garrison
  put(G4, sid, 'Empire', 'stormtrooper'); // token threat
  check('a token threat against a real garrison -> never', !hopelessFor(G4, 'Rebel').hopeless);
}

console.log('\n[ the UI wiring cannot silently detach ]');
{
  const ui = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('PlayTab imports the detector', ui.includes("import { hopelessFor } from './aiResign'"));
  check('the offer is once per game (localStorage key by gameId)', ui.includes('rebellion-resign-offered-'));
  check('accepting calls the engine ending', ui.includes('phases.resignGame(G, aiSide'));
  check('and archives the finished game like any other ending', /resignGame[\s\S]{0,120}persist\(\)/.test(ui));
  check('the offer never runs in online games', /isGameOver \|\| online\) return/.test(ui));
  check("the modal says it in the AI's voice", ui.includes('convinced') && ui.includes('resignation'));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
