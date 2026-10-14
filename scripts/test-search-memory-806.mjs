// @timeout 120000
// #806 (eu46ho, playing Rebel): "Imperials seem to be going back to trying to
// keep all their forces in one bunch which makes it very easy for the rebels to
// just move their base across the map and stay away from the mass of units."
//
// The reporter's game: from round 4 the Empire's 20-34 unit stack walked
// Yavin → Dathomir → Yavin → Dathomir, two remote worlds it had already searched,
// while the base sat at Ryloth. The Empire's record of searched worlds only took
// systems it controlled or had subjugated, and remote systems can never be
// subjugated (rr p.12) — so landing troops there was forgotten the moment they
// left, and the hunt treated the world as a suspect again.
//
// Pins: (1) Imperial ground in a system records it as searched, and it stays
// searched after the troops leave, until the base moves; (2) ships alone do
// not ("If the Imperial player has ships in a system, but no ground units, the
// Rebel base is not revealed"); (3) the hunt skips searched worlds — the
// reporter's board picks the unsearched neighbour, where SWR_SEARCH_MEMORY=0
// walks back into the searched one; (4) the Empire player's map marks only
// ground-searched systems.
// Run: node scripts/test-search-memory-806.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');
const { baseCandidates } = await import('../src/play/mctsAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

// Child mode: print where the lone Empire stack goes, for the counterfactual.
if (process.argv[2] === '--pick') {
  const { G } = reporterBoard();
  const top = ai.bestCommandAction(G, 'Empire').find((a) => a.kind === 'activate');
  console.log(`PICK ${top?.targetSystemId ?? 'none'}`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** The reporter's shape: one Imperial stack, which has searched Yavin and now
 *  stands on Dathomir. Dathomir's other neighbours are Dantooine (never
 *  visited) and two Imperial worlds with nothing to gain. */
function reporterBoard() {
  const G = createGame(data, { seed: 806, autoSetupUnits: true });
  if (['yavin', 'dathomir', 'dantooine'].includes(G.rebelBaseSystemId)) throw new Error('seed put the base on the test worlds');
  const stack = G.map.systems.mygeeto.units.filter((u) => u.side === 'Empire').map((u) => u.instanceId);
  for (const id of stack) M.moveUnit(G, id, 'mygeeto', 'yavin');
  for (const id of stack) M.moveUnit(G, id, 'yavin', 'dathomir');
  for (const [sid, ss] of Object.entries(G.map.systems)) if (sid !== 'dathomir' && sid !== 'coruscant') ss.units = ss.units.filter((u) => u.side !== 'Empire');
  for (const s of ['mandalore', 'mygeeto']) { G.map.systems[s].loyalty = 'imperial'; G.map.systems[s].subjugated = false; }
  G.empire.leaderPool = ['general-tagge'];
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  return { G, stack };
}

console.log('[ the record: troops on the ground search a world, and it stays searched ]');
{
  const G = createGame(data, { seed: 806, autoSetupUnits: true });
  check('Yavin, Dathomir and Dantooine are remote (they can never be subjugated)', ['yavin', 'dathomir', 'dantooine'].every((s) => G.catalog.systems[s].isRemote));
  const trooper = G.map.systems.mygeeto.units.find((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
  M.moveUnit(G, trooper.instanceId, 'mygeeto', 'yavin');
  check('landing a trooper on remote Yavin records it as searched', (G.empireSearchedRuledOut ?? []).includes('yavin'), JSON.stringify(G.empireSearchedRuledOut));
  M.moveUnit(G, trooper.instanceId, 'yavin', 'mygeeto');
  check('…and Yavin stays searched after the trooper leaves', (G.empireSearchedRuledOut ?? []).includes('yavin'));
  const tie = G.map.systems.mygeeto.units.find((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'space');
  M.moveUnit(G, tie.instanceId, 'mygeeto', 'dantooine');
  check('a ship alone does not search a world (rr: ships without ground do not reveal the base)', !(G.empireSearchedRuledOut ?? []).includes('dantooine'));
  M.moveUnit(G, tie.instanceId, 'dantooine', 'mygeeto');
  M.resetEmpireSearchedForBaseMove(G);
  check('when the base moves, an empty searched world is a suspect again', !(G.empireSearchedRuledOut ?? []).includes('yavin'));
  check('the hidden base\'s own system is never marked searched', !(G.empireSearchedRuledOut ?? []).includes(G.rebelBaseSystemId));
}

console.log('[ the hunt reads the record ]');
{
  const { G } = reporterBoard();
  const cands = baseCandidates(G);
  check('the search AI no longer lists Yavin as a possible base', !cands.includes('yavin'), cands.join(','));
  check('…but still lists unvisited Dantooine', cands.includes('dantooine'), cands.join(','));
  const pick = (env) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--pick'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return (r.stdout.match(/PICK (\S+)/) ?? [])[1] ?? `error: ${r.stderr.slice(-300)}`;
  };
  // SWR_SEARCH_MEMORY (the heuristic half) is OFF by default — measured, see
  // empirePlanner.ts — so the lever is exercised explicitly here.
  const now = pick({ SWR_SEARCH_MEMORY: '1' });
  const before = pick({ SWR_SEARCH_MEMORY: '0' });
  check('with SWR_SEARCH_MEMORY=1 the stack on Dathomir moves on to Dantooine, the world it has not searched', now === 'dantooine', now);
  check('control: without it the heuristic walks back into searched Yavin (the reported ping-pong)', before === 'yavin', before);
  const shipped = pick({ SWR_SEARCH_MEMORY: '1', SWR_HUNT_OCCUPY: '1', SWR_EMPIRE_PLANNER: '1' });
  check('the same with the browser\'s hunt and planner settings on', shipped === 'dantooine', shipped);
  const dflt = pick({ SWR_SEARCH_MEMORY: '' });
  check('the heuristic half ships OFF (it measured 15/30 against 18/30 for the engine record alone)', dflt === 'yavin', dflt);
}

console.log('[ tripwires ]');
{
  const play = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('the Empire\'s map marks a system searched for GROUND only, not any unit',
    /ss\.units\.some\(\(u\) => u\.side === 'Empire' && G\.catalog\.unitTypes\[u\.typeId\]\?\.theater === 'ground'\)\) out\.add\(id\)/.test(play)
    && !/if \(ss\.units\.some\(\(u\) => u\.side === 'Empire'\)\) out\.add\(id\)/.test(play));
  const planner = readFileSync(join(ROOT, 'src/play/empirePlanner.ts'), 'utf8');
  check('the strike-fleet hunt target also skips searched worlds', /if \(!ss \|\| searched\.has\(cid\)\) continue;/.test(planner));
  const rai = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  // Searched worlds are priced as cleared, NOT dropped from the candidate set:
  // the narrowing / hunt gates count that set, and shrinking it moved them
  // (18 → 12 Empire wins in a 30-seed pair).
  check('searched worlds count as cleared, not as removed candidates',
    /if \(searchedSinceMove\.has\(sid\)\) return true;/.test(rai) && !/if \(searched\.has\(sid\)\) return false;/.test(rai));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
