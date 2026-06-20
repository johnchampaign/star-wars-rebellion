// Rapid Mobilization (#365): the card offers "choose 1 of the following" —
// (1) move units to the base, or (2) establish a new base. Looking at the probe
// cards for a new base location is PART of option 2, so the Rebel must commit to
// the branch BEFORE any probes are drawn/shown. Previously the engine drew and
// revealed the candidates first, letting the player peek then take option 1.
// Run: node scripts/test-rapid-mobilization-365.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
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
const newGame = (seed) => createGame(data, { seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
const drawLogs = (G) => G.turnLog.filter((e) => e.kind === 'rapid-mobilization-probe-draw').length;

// Build a fresh RapidMobilizationBranch pending choice (hidden base).
function setupBranch(G) {
  G.pendingRapidMobilizations = [{ twoLeaders: false }];
  G.pendingChoice = {
    kind: 'RapidMobilizationBranch', side: 'Rebel',
    twoLeaders: false, baseRevealed: false, moveUnitsAvailable: true,
  };
}

console.log('\n[ #365: the branch choice exposes NO probe candidates ]');
{
  const G = newGame(3);
  setupBranch(G);
  const c = G.pendingChoice;
  check('branch carries no drawnProbeIds', !('drawnProbeIds' in c) || c.drawnProbeIds === undefined);
  check('branch carries no baseCandidates', !('baseCandidates' in c) || c.baseCandidates === undefined);
  check('no probes drawn at the branch step', drawLogs(G) === 0);
}

console.log('\n[ choosing "move units" draws NO probes ]');
{
  const G = newGame(3);
  setupBranch(G);
  const deckBefore = G.probeDeck.length;
  const r = phases.resolveRapidMobilizationBranch(G, 'move-units');
  check('move-units accepted', r.ok, r.reason);
  check('no probe-draw happened', drawLogs(G) === 0);
  check('probe deck size unchanged', G.probeDeck.length === deckBefore, `${deckBefore} -> ${G.probeDeck.length}`);
  check('posted the move-units sub-pick', G.pendingChoice?.kind === 'RapidMobilizationMovePick');
}

console.log('\n[ choosing "establish base" draws the probes only NOW ]');
{
  const G = newGame(3);
  setupBranch(G);
  const r = phases.resolveRapidMobilizationBranch(G, 'establish-base');
  check('establish-base accepted', r.ok, r.reason);
  check('probes were drawn at this step (4)', drawLogs(G) === 1);
  // Either a base pick is posted (legal candidate) or the RM ended (none legal).
  const posted = G.pendingChoice?.kind === 'RapidMobilizationBasePick';
  check('posted a base pick OR ended with no legal candidate',
    posted || G.pendingChoice === undefined, G.pendingChoice?.kind);
  if (posted) {
    check('base pick carries the drawn probes (for a decline)',
      Array.isArray(G.pendingChoice.drawnProbeIds) && G.pendingChoice.drawnProbeIds.length === 4);
  }
}

console.log('\n[ look-and-decline returns the probes to the bottom, keeps the base ]');
{
  // Find a seed that yields a legal base candidate so a BasePick is posted.
  let done = false;
  for (let seed = 1; seed <= 60 && !done; seed++) {
    const G = newGame(seed);
    setupBranch(G);
    phases.resolveRapidMobilizationBranch(G, 'establish-base');
    if (G.pendingChoice?.kind !== 'RapidMobilizationBasePick') continue;
    done = true;
    const oldBase = G.rebelBaseSystemId;
    const drawn = [...G.pendingChoice.drawnProbeIds];
    const r = phases.resolveRapidMobilizationBasePick(G, null); // decline
    check(`(seed ${seed}) decline accepted`, r.ok, r.reason);
    check('base unchanged (kept current base)', G.rebelBaseSystemId === oldBase);
    // (Exact deck size isn't asserted: finishRapidMobilization advances into the
    // Refresh phase, which draws probes of its own. The point is none are lost.)
    check('every drawn probe is back in the deck (not lost on decline)',
      drawn.every((p) => G.probeDeck.includes(p)));
    check('choice cleared / RM finished', G.pendingChoice === undefined || G.pendingChoice.kind !== 'RapidMobilizationBasePick');
  }
  check('found a seed with a legal base candidate', done);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
