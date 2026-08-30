// cjmwqv (#582): "The empire player had a massive fleet next to coruscant and
// corellia. I have heart of the empire that I scored last turn. The ai went for
// corellia instead of coruscant and in so doing handed me 2 free reputation."
//
// He was right, and the same shape came back as #697 ("a Rebel force sat on
// Coruscant with zero Imperial units ... the Empire's nine-ship fleet was one
// jump away at Corellia"). Two independent terms had to land before the Empire
// would answer it, and both shipped AFTER this report:
//
//   THEATER_AWARE_ODDS (#697)  — the "can't win the ground fight" penalty fired
//     even when the Empire brought NO ground, and combat.ts never runs a ground
//     battle in that case. Coruscant scored negative and was filtered out of
//     the candidate list entirely, before anything could rank it.
//   DEFEND_CORUSCANT (#489)    — nothing rewarded reinforcing the capital while
//     a Rebel army was standing on it. Heart Of The Empire pays 2 reputation at
//     EVERY Refresh for as long as Coruscant "contains a Rebel unit and no
//     Imperial units", and the card RETURNS TO HAND, so the leak is unbounded
//     until the Empire puts something back. Merely arriving denies it.
//
// The fixture is the reporter's own position, decoded from the report he filed.
// One edit, and it is the edit the project's fixture convention calls for: the
// board was captured AFTER the Empire had already made the move being
// complained about, so Grand Moff Tarkin is standing on Corellia — and RAW
// (Rules Reference, "Activating Systems", p.02) says "a player cannot move his
// units out of a system that contains one of his faction's leaders". With him
// there the 24-unit Corellia stack is legally frozen and declining to attack is
// CORRECT, so the test restores him to the leader pool to recreate the decision
// the reporter actually saw.
//
// Run: node scripts/test-coruscant-retake-582.mjs
//   Counterfactual: SWR_THEATER_ODDS=0 SWR_DEFEND_CORUSCANT=0 must FAIL —
//   with both terms off, Coruscant falls from first (70) to fourth (18) and the
//   Empire wanders off to Bothawui, which is the reported bug verbatim.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const fixture = readFileSync(join(ROOT, 'scripts/fixtures/coruscant-retake-582.json'), 'utf-8');
const G = codec.decode(fixture, setup.buildCatalog(data));

const units = (sid, side) => (G.map.systems[sid]?.units ?? []).filter((u) => u.side === side);

console.log('\n[ the fixture is the reported position ]');
{
  check('decoded into a Command phase on turn 7',
    G.phase === 'Command' && G.timeMarker === 7, `${G.phase} t${G.timeMarker}`);
  check('Coruscant is Imperial-loyal but held by a Rebel army',
    G.map.systems['coruscant'].loyalty === 'imperial' && units('coruscant', 'Rebel').length >= 10,
    `loyalty=${G.map.systems['coruscant'].loyalty} rebels=${units('coruscant', 'Rebel').length}`);
  check('and no Imperial unit is left on it — Heart Of The Empire is live',
    units('coruscant', 'Empire').length === 0);
  check('the Rebel has already scored Heart Of The Empire once',
    (G.rebel.scoredObjectives ?? []).some((o) => o.objectiveId === 'heart-of-the-empire-2'));
  check('Corellia is adjacent to Coruscant',
    (G.catalog.adjacency['corellia'] ?? []).includes('coruscant'));
  check('and it is where the massive Imperial fleet went instead',
    units('corellia', 'Empire').length >= 20, `${units('corellia', 'Empire').length} units`);
}

console.log('\n[ RAW: his own leader on Corellia freezes that stack ]');
{
  check('Tarkin is standing on Corellia in the captured board',
    (G.empire.leadersOnBoard['corellia'] ?? []).includes('grand-moff-tarkin'),
    JSON.stringify(G.empire.leadersOnBoard));
  const acts = ai.bestCommandAction(G, 'Empire');
  check('so the Empire correctly does NOT propose an assault it cannot supply',
    !acts.some((a) => a.kind === 'activate' && a.targetSystemId === 'coruscant'));
}

// Recreate the decision point: put the acting leader back in the pool so the
// Corellia stack is legally movable, exactly as it was when the AI chose.
delete G.empire.leadersOnBoard['corellia'];
G.empire.leaderPool = [...G.empire.leaderPool, 'grand-moff-tarkin'];

console.log('\n[ #582 the Empire now goes back for its own capital ]');
{
  const acts = ai.bestCommandAction(G, 'Empire');
  const top = acts[0];
  check('an activation on Coruscant is offered at all',
    acts.some((a) => a.kind === 'activate' && a.targetSystemId === 'coruscant'),
    acts.map((a) => `${a.kind}:${a.targetSystemId}`).join(' '));
  check('and retaking the capital is the best move on the board',
    top?.kind === 'activate' && top?.targetSystemId === 'coruscant',
    `chose ${top?.kind}:${top?.targetSystemId} (score ${top?.score})`);
  const cor = acts.find((a) => a.kind === 'activate' && a.targetSystemId === 'coruscant');
  const others = acts.filter((a) => a !== cor && a.kind !== 'pass').map((a) => a.score);
  check('it outranks every other candidate, not just squeaks past one',
    others.length === 0 || cor.score > Math.max(...others),
    `coruscant=${cor?.score} best-other=${others.length ? Math.max(...others) : 'n/a'}`);
  check('the Empire is not wandering off to a neutral land-grab instead',
    top?.targetSystemId !== 'bothawui' && top?.targetSystemId !== 'alderaan');
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
