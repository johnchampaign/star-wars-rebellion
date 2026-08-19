// #728 — "The Rebel AI player used the mission Misdirection when I had no leaders
// in my leader pool. This is essentially useless, as this mission prevents my
// opposing another of his missions, but I could not oppose him anyway."
//
// The reporter is exactly right, and the card text is unambiguous:
//   "Attempt in any system that contains an Imperial unit. If successful, choose
//    1 of your leaders. Imperial leaders IN THE LEADER POOL cannot be sent to
//    oppose this leader's mission this round."
// The restriction is the entire payoff — there is no secondary clause. With an
// empty Imperial pool there is nobody to restrain, so the card is a pure no-op
// and the Rebel has burned a leader and a mission slot for nothing.
//
// This is the mirror image of draw-them-out ("Empire places a Rebel leader from
// the pool here — nothing to place when the Rebel pool is empty"), which already
// had its gate. Misdirection was missed.
//
// Opposition really does read the pool: phases.ts builds the opposing candidate
// list from `oppFaction.leaderPool`, so an empty pool means no opposition was
// possible with or without the card. Asserted below rather than assumed.
// Run: node scripts/test-misdirection-pointless-728.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { missionRevealIsPointless } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const newGame = () => createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
const SYS = 'coruscant'; // any system; the gate is pool-based, not target-based

console.log('\n[ the card text really is pool-scoped ]');
{
  const card = data.missions.missions.find((m) => m.id === 'misdirection');
  check('Misdirection exists in the mission catalog', !!card);
  check('its rules text restricts leaders "in the leader pool"',
    /leader pool cannot be sent to oppose/i.test(card.rulesText), card?.rulesText);
  check('it is a Rebel mission', card.side === 'Rebel', card?.side);
}

console.log('\n[ #728 — empty Imperial pool makes Misdirection a no-op ]');
{
  const G = newGame();
  G.empire.leaderPool = [];
  check('the Imperial leader pool is empty (the reported state)',
    G.empire.leaderPool.length === 0);
  check('reveal is flagged pointless — the AI will not spend the card',
    missionRevealIsPointless(G, 'Rebel', 'misdirection', SYS) === true);
}

console.log('\n[ with Imperial leaders available the card is worth playing ]');
{
  const G = newGame();
  check('default setup leaves Imperial leaders in the pool',
    G.empire.leaderPool.length > 0, JSON.stringify(G.empire.leaderPool));
  check('NOT pointless while the Empire can still oppose',
    missionRevealIsPointless(G, 'Rebel', 'misdirection', SYS) === false);

  // One leader is enough to make the restriction meaningful.
  const G1 = newGame();
  G1.empire.leaderPool = [G.empire.leaderPool[0]];
  check('a single Imperial leader in the pool is enough',
    missionRevealIsPointless(G1, 'Rebel', 'misdirection', SYS) === false);
}

console.log('\n[ the gate is Rebel-side only ]');
{
  // Misdirection is a Rebel card; the Empire-side query must not be gated by
  // the Empire's own pool (mirrors draw-them-out's `side === 'Empire'` guard).
  const G = newGame();
  G.empire.leaderPool = [];
  check('an Empire-side query is unaffected',
    missionRevealIsPointless(G, 'Empire', 'misdirection', SYS) === false);
}

console.log('\n[ the premise: opposition is drawn from the leader pool ]');
{
  const src = readFileSync(join(ROOT, 'src/engine/phases.ts'), 'utf8');
  check('phases.ts builds the opposing candidate list from oppFaction.leaderPool',
    /oppFaction\.leaderPool\.slice\(\)/.test(src));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
