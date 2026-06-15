// #289 — Under the Radar (timing: Immediate) fires the moment it's recruited,
// per RAW ("must be used as soon as the player gains the card"), instead of
// sitting in hand for an at-will play.
// Run: node scripts/test-under-the-radar-289.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
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

const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true },
});

console.log('\n[ #289 Under the Radar fires immediately on recruit ]');
{
  const G = createGame(data, opts(970));
  // Stage a Rebel recruit pick whose kept card is Under the Radar.
  G.refreshPaused = { pendingRecruitPicks: [
    { side: 'Rebel', drawnIds: ['under-the-radar', 'rebel-planning'] },
  ], logStart: 0 };
  G.pendingChoice = { kind: 'RecruitActionCardPick', side: 'Rebel',
    drawnIds: ['under-the-radar', 'rebel-planning'], canDrawMore: false };

  const r1 = phases.resolveRecruitActionCardPick(G, 'under-the-radar');
  check('keep Under the Radar ok', r1.ok, r1.reason);
  // The card recruits Cassian or Saw → a leader pick may be posted first.
  if (G.pendingChoice?.kind === 'RecruitLeaderPick') {
    const lid = G.pendingChoice.candidates[0];
    const r2 = phases.resolveRecruitLeaderPick(G, lid);
    check('recruit leader ok', r2.ok, r2.reason);
  }
  // Now the Immediate effect must have fired → UnderTheRadarKeep is pending,
  // NOT sitting in hand waiting for a manual play.
  check('Under the Radar fired immediately (keep choice posted)',
    G.pendingChoice?.kind === 'UnderTheRadarKeep',
    `pendingChoice=${G.pendingChoice?.kind}`);
  check('keep choice tagged viaRecruit',
    G.pendingChoice?.kind === 'UnderTheRadarKeep' && G.pendingChoice.viaRecruit === true);
  check('card left the hand (discarded, not held for later)',
    !G.rebel.actionHand.includes('under-the-radar'));

  // Resolve the keep — a probe is held and the recruit/refresh flow resumes.
  if (G.pendingChoice?.kind === 'UnderTheRadarKeep') {
    const probe = G.pendingChoice.candidates[0];
    const r3 = phases.resolveUnderTheRadarKeep(G, probe);
    check('resolve keep ok', r3.ok, r3.reason);
    check('probe is now held facedown', G.rebel.heldProbe === probe,
      `held=${G.rebel.heldProbe}`);
    check('recruit flow resumed (no UnderTheRadarKeep left pending)',
      G.pendingChoice?.kind !== 'UnderTheRadarKeep');
  }
}

console.log('\n[ #289 single-probe deck auto-holds without a keep prompt ]');
{
  const G = createGame(data, opts(971));
  G.probeDeck = ['probe-mygeeto']; // exactly one → auto-hold, no choice
  G.refreshPaused = { pendingRecruitPicks: [
    { side: 'Rebel', drawnIds: ['under-the-radar', 'rebel-planning'] },
  ], logStart: 0 };
  G.pendingChoice = { kind: 'RecruitActionCardPick', side: 'Rebel',
    drawnIds: ['under-the-radar', 'rebel-planning'], canDrawMore: false };
  phases.resolveRecruitActionCardPick(G, 'under-the-radar');
  if (G.pendingChoice?.kind === 'RecruitLeaderPick') {
    phases.resolveRecruitLeaderPick(G, G.pendingChoice.candidates[0]);
  }
  check('auto-held the only probe (no keep prompt)',
    G.rebel.heldProbe === 'probe-mygeeto' && G.pendingChoice?.kind !== 'UnderTheRadarKeep',
    `held=${G.rebel.heldProbe} pc=${G.pendingChoice?.kind}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
