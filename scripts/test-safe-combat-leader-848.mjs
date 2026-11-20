// #848 (mrvvfh, playing Rebel, cinematic combat on): "losing Vader turn 1 by
// my attack on the Death Star under construction, protected by a single clone
// trooper, was critical". Replayed from the reporter's own turn-1 board
// (scripts/fixtures/safe-combat-leader-848.json, the game log's turn-1 snapshot).
//
// Jan Dodonna brought a corvette, transport, X-wing, U-wing, airspeeder and two
// troopers from Mustafar into Hoth (DSUC, 4 TIEs, 1 Stormtrooper). The Empire AI
// always added its best pool leader to a combat, so Vader joined; the Rebel
// played Confrontation, wiped the lone Stormtrooper, and Vader was eliminated
// at the end of the Command phase.
//
// Pins: on that board the Empire adds NO leader; with Confrontation already in
// the Rebel discard, or a ground garrison the Rebel can't wipe in a round, it
// still adds its best leader (Vader); base-game combat is untouched; and the
// SWR_SAFE_COMBAT_LEADER=0 control reproduces the old pick.
// Run: node scripts/test-safe-combat-leader-848.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const combat = await import('../src/engine/combat.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const raw = readFileSync(join(ROOT, 'scripts/fixtures/safe-combat-leader-848.json'), 'utf8');
const SYS = 'hoth';
const CONF = 'cin-rebel-ground-confrontation';
const CONTROL = process.argv[2] === '--control';
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** Replay Dodonna's activation: units Mustafar → Hoth, combat begins, and the
 *  Empire's add-a-leader choice is posted. Returns the leader the AI added. */
function strike({ cinematic = true, confDiscarded = false, extraGarrison = [] } = {}) {
  const G = codec.decode(raw, setup.buildCatalog(data));
  G.expansion.cinematicCombat = cinematic;
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  if (confDiscarded) G.rebel.cinematicTacticDiscard = [CONF];
  const must = G.map.systems.mustafar;
  const hoth = G.map.systems[SYS];
  hoth.units.push(...must.units.filter((u) => u.side === 'Rebel'));
  must.units = must.units.filter((u) => u.side !== 'Rebel');
  let n = 0;
  for (const t of extraGarrison) hoth.units.push({ instanceId: `x848-${n++}`, typeId: t, side: 'Empire', damage: 0 });
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== 'jan-dodonna');
  (G.rebel.leadersOnBoard[SYS] ??= []).push('jan-dodonna');
  combat.beginCombat(G, 'Rebel', 'mustafar', SYS);
  combat.runCombat(G);
  for (let i = 0; i < 4 && G.pendingChoice?.kind === 'CombatAddLeaderPick' && G.pendingChoice.side === 'Rebel'; i++) {
    combat.resolveCombatAddLeaderPick(G, null);
  }
  const pc = G.pendingChoice;
  if (pc?.kind !== 'CombatAddLeaderPick' || pc.side !== 'Empire') throw new Error(`no Empire add-leader choice: ${JSON.stringify(pc)}`);
  AI.stepOnce(G, 'Empire');
  return (G.empire.leadersOnBoard[SYS] ?? [])[0] ?? null;
}

if (CONTROL) {
  // Child process under SWR_SAFE_COMBAT_LEADER=0: print the reported-board pick.
  console.log(`PICK=${strike()}`);
  process.exit(0);
}

console.log('[ the reporter\'s board: 1 Stormtrooper vs 2 Rebel troopers + airspeeder ]');
const reported = strike();
check('Empire adds no leader to a ground force the Rebel can wipe', reported === null, `added ${reported}`);
const G0 = codec.decode(raw, setup.buildCatalog(data));
G0.map.systems[SYS].units.push(...G0.map.systems.mustafar.units.filter((u) => u.side === 'Rebel'));
check('the helper flags the board', AI.empireLeaderFacesConfrontation(G0, SYS) === true);

console.log('\n[ controls: the leader still joins when the risk is gone ]');
const spent = strike({ confDiscarded: true });
check('Confrontation already discarded → adds Vader', spent === 'darth-vader', `added ${spent}`);
const garrisoned = strike({ extraGarrison: ['at-at', 'at-at'] });
check('two AT-ATs in the garrison (no one-round wipe) → adds Vader', garrisoned === 'darth-vader', `added ${garrisoned}`);
const base = strike({ cinematic: false });
check('base-game combat (no Confrontation) → adds Vader', base === 'darth-vader', `added ${base}`);

console.log('\n[ counterfactual: SWR_SAFE_COMBAT_LEADER=0 ]');
const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--control'], {
  env: { ...process.env, SWR_SAFE_COMBAT_LEADER: '0' }, encoding: 'utf8',
});
const ctl = /PICK=(\S+)/.exec(out)?.[1];
check('flag off reproduces the report (Vader joins)', ctl === 'darth-vader', `control pick=${ctl}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
