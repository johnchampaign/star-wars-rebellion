// #810 (fl4qs5, playing Empire): "Princess Leia is playing Build Alliance in
// Sullist. There are no other rebel leaders in the system. It says 4 diplomacy
// dice will be rolled when she only has 2."
//
// The 4 was right: Build Alliance reads "If there are Rebel units in this
// system, roll 2 additional dice", and the report's screenshot shows a Rebel
// trooper on Sullust. But the opposition prompt only printed the total, so a
// correct roll looked like a bug. The prompt now carries the card's share
// (attackerCardDice) and says where the extra dice come from.
//
// Pins: Leia alone rolls 2, or 4 with a Rebel unit present; the choice reports
// the card's +2 separately; the prompt explains it.
// Run: node scripts/test-build-alliance-dice-810.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const SYS = 'sullust';

/** Leia (2 diplomacy) alone reveals Build Alliance at Sullust; returns the
 *  Empire's opposition prompt. */
function opposePrompt({ rebelUnit }) {
  const G = createGame(data, { seed: 810, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Rebel' || ss !== G.map.systems[SYS]);
  G.map.systems[SYS].units = G.map.systems[SYS].units.filter((u) => u.side !== 'Empire');
  G.map.systems[SYS].loyalty = 'neutral'; G.map.systems[SYS].subjugated = false;
  if (rebelUnit) M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== 'princess-leia');
  if (!G.rebel.missionHand.includes('build-alliance')) G.rebel.missionHand.push('build-alliance');
  G.rebel.leadersOnMissions.push({ missionId: 'build-alliance', leaderIds: ['princess-leia'] });
  G.empire.leaderPool = ['darth-vader', 'grand-moff-tarkin'];
  G.phase = 'Command'; G.currentPlayer = 'Rebel'; G.passedThisCommand = [];
  const r = phases.revealMission(G, 'Rebel', 'build-alliance', SYS);
  if (!r.ok) throw new Error(`reveal refused: ${r.reason}`);
  return G.pendingChoice;
}

console.log('[ the dice are right ]');
{
  const leia = createGame(data, { seed: 1 }).catalog.leaders['princess-leia'];
  check('Leia has 2 diplomacy', leia?.skills?.diplomacy === 2, JSON.stringify(leia?.skills));
  const alone = opposePrompt({ rebelUnit: false });
  check('alone in an empty system she rolls 2', alone?.kind === 'OpposeMission' && alone.attackerDice === 2, JSON.stringify(alone));
  check('…and the card adds nothing', !alone?.attackerCardDice);
  const withUnit = opposePrompt({ rebelUnit: true });
  check('with a Rebel trooper there she rolls 4 (the reported case)', withUnit?.kind === 'OpposeMission' && withUnit.attackerDice === 4, JSON.stringify(withUnit));
  check('…and the prompt knows 2 of them come from the card', withUnit?.attackerCardDice === 2, JSON.stringify(withUnit?.attackerCardDice));
}

console.log('[ the prompt explains it ]');
{
  const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('the opposition prompt splits the total into skills + the card', /plus \{choice\.attackerCardDice\} from the card itself/.test(src));
  check('…and names the Build Alliance reason', /choice\.missionId === 'build-alliance' \? <> \(Rebel units are in \{targetName\}\)<\/>/.test(src));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
