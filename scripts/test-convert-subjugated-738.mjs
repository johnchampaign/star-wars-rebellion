// @timeout 120000
// #738 — "the AI never made them loyal, despite having them under control for
// most of the game... The empire should never accept lagging behind in capital
// ships." (BGG, @Kazuar, playing Rebel.)
//
// He subjugated-then-stalled diagnosis was right, and the cause was in the
// Empire's own mission scoring.
//
// RR "Subjugation" is explicit that subjugation buys CONTROL, not full OUTPUT:
//   "The Imperial player can deploy units to, and build units from, subjugated
//    systems." / "When building units from a subjugated system, the Imperial
//    player uses only the LEFT-MOST resource icon." / "If a neutral subjugated
//    system gains Imperial loyalty, the system's subjugation marker is flipped
//    to its loyalty side."
// phases.ts enforces that with `icons = icons.slice(0, 1)`.
//
// Mon Calamari and Corellia both read [triangle, SQUARE]. While subjugated the
// Empire collects the triangle; the capital-ship SQUARE stays locked behind
// Imperial loyalty. So converting a subjugated 2-icon world is one of the
// highest-value loyalty plays on the board.
//
// The AI scored it as one of the LOWEST: a flat -12 on any loyalty-gain mission
// aimed at a subjugated system, commented "already controlled, low value". That
// priced control and ignored the locked production, so the Empire took Mon
// Calamari and Corellia and then permanently declined to finish the job —
// exactly the reported end state (one ISD and three carriers, ground stranded
// for want of transports).
//
// It also explains why the reporter saw the conversion get HALF done: Imperial
// Propaganda flips Rebel-loyal systems in a region to neutral and is scored
// separately with no subjugation penalty, so step 1 (Rebel -> neutral) happened
// and step 2 (neutral -> Imperial) never did.
//
// Fix: score the conversion by what it actually unlocks. SWR_CONVERT_SUBJUGATED=0
// restores the old flat penalty, and this test runs that arm in a child process
// so the comparison cannot be vacuous.
//
// Run: node scripts/test-convert-subjugated-738.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

const TWO_ICON = 'corellia';    // [triangle, SQUARE] — capital ship behind the lock
const ONE_ICON = 'alderaan';    // [triangle] — nothing behind the lock

/** Score rule-by-fear at a system put into a given loyalty/subjugation state. */
function score(state, sysId) {
  const G = createGame(data, { seed: 5, autoSetupUnits: true });
  const ss = G.map.systems[sysId];
  ss.loyalty = state.loyalty;
  ss.subjugated = !!state.subjugated;
  return AI.empireMissionTargetScore(G, 'rule-by-fear', sysId);
}

const scores = {
  subjNeutral2: score({ loyalty: 'neutral', subjugated: true }, TWO_ICON),
  subjNeutral1: score({ loyalty: 'neutral', subjugated: true }, ONE_ICON),
  subjRebel2:   score({ loyalty: 'rebel',   subjugated: true }, TWO_ICON),
  plainNeutral2:score({ loyalty: 'neutral', subjugated: false }, TWO_ICON),
  imperial2:    score({ loyalty: 'imperial',subjugated: false }, TWO_ICON),
};

// Child mode: print scores and exit, so the parent can compare arms.
if (process.env.SWR_CONVERT_SUBJUGATED === '0') {
  console.log(JSON.stringify(scores));
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const off = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'scripts/test-convert-subjugated-738.mjs')],
  { env: { ...process.env, SWR_CONVERT_SUBJUGATED: '0' }, encoding: 'utf8' }).trim());

console.log('\n[ the premise: subjugation locks every icon past the first ]');
{
  const ph = readFileSync(join(ROOT, 'src/engine/phases.ts'), 'utf8');
  check('phases.ts still slices a subjugated non-Imperial system to 1 icon',
    /subjugated && ss\.loyalty !== 'imperial'\) icons = icons\.slice\(0, 1\)/.test(ph));
  const sys = j('systems.json');
  const items = Array.isArray(sys) ? sys : (sys.systems ?? sys);
  const twoIcon = items.find((o) => o.id === TWO_ICON);
  check(`${TWO_ICON} really does have a second icon to unlock`,
    (twoIcon.resources ?? []).length === 2, JSON.stringify(twoIcon.resources));
  check('and its second icon is the capital-ship SQUARE',
    twoIcon.resources[1].shape === 'square', JSON.stringify(twoIcon.resources[1]));
}

console.log('\n[ converting a subjugated system is now WORTH something ]');
{
  check('a subjugated 2-icon world outscores the old flat-penalty arm',
    scores.subjNeutral2 > off.subjNeutral2,
    `on=${scores.subjNeutral2} off=${off.subjNeutral2}`);
  check('the old arm really did penalise it (non-vacuous)',
    off.subjNeutral2 < off.plainNeutral2,
    `off subj=${off.subjNeutral2} vs off plain=${off.plainNeutral2}`);
  check('value scales with what is actually locked (2-icon > 1-icon)',
    scores.subjNeutral2 > scores.subjNeutral1,
    `2-icon=${scores.subjNeutral2} 1-icon=${scores.subjNeutral1}`);
}

console.log('\n[ but it stays honest about the cases that unlock nothing ]');
{
  check('a 1-icon subjugated world gets NO unlock bonus (nothing behind the lock)',
    scores.subjNeutral1 <= off.subjNeutral1 + 12,
    `on=${scores.subjNeutral1} off=${off.subjNeutral1}`);
  check('subjugated-with-Rebel-loyalty scores below subjugated-neutral (two gains away)',
    scores.subjRebel2 < scores.subjNeutral2,
    `rebel=${scores.subjRebel2} neutral=${scores.subjNeutral2}`);
  check('an already-Imperial system is still heavily penalised (cannot gain)',
    scores.imperial2 < scores.plainNeutral2 - 20,
    `imperial=${scores.imperial2} plain=${scores.plainNeutral2}`);
  check('and that penalty is unchanged by this lever',
    scores.imperial2 === off.imperial2, `${scores.imperial2} vs ${off.imperial2}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
