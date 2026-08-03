// #681 — "Post Bounty should not target ringed leaders."
//
// The card reads "Attach a bounty ring to 1 UN-RINGED leader." The candidate
// filter excluded only leaders already carrying a BOUNTY, so a leader wearing a
// droid ring was still offered. The reporter had R2-D2 attached to Leia and the
// Empire bountied her anyway.
//
// Run: node scripts/test-post-bounty-unringed-681.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const SYS = 'alderaan';

/** A failed Rebel mission at SYS with Jabba present, ready for the Post Bounty
 *  offer. `rings` maps leaderId -> ring to pre-attach. */
function board(seed, rings = {}) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.empire.actionHand = ['post-bounty'];
  M.placeLeader(G, 'Empire', 'jabba', SYS);
  for (const [lid, ring] of Object.entries(rings)) M.attachRing(G, lid, ring);
  return G;
}
/** Offer Post Bounty against `leaderIds`; returns the posted candidate list. */
function offer(G, leaderIds, missionId = 'infiltration') {
  G.pendingMission = { missionId, targetSystemId: SYS, side: 'Rebel' };
  const posted = phases.maybePostBountyOffer(G, 'Rebel', missionId, leaderIds);
  return { posted, candidates: G.pendingChoice?.kind === 'PostBountyOffer' ? G.pendingChoice.candidates : null };
}

console.log('\n[ the card text still says un-ringed ]');
{
  const G = board(681);
  const txt = (G.catalog.actions['post-bounty']?.rulesText ?? '').toLowerCase();
  check('rulesText says un-ringed', /un-?ringed/.test(txt), txt);
}

console.log('\n[ #681 a leader wearing a droid ring is not a candidate ]');
{
  const G = board(681, { 'princess-leia': 'r2d2' });
  check('Leia really has the R2-D2 ring',
    (G.leaderAttachments?.['princess-leia'] ?? []).includes('r2d2'),
    JSON.stringify(G.leaderAttachments?.['princess-leia']));
  const { candidates } = offer(G, ['princess-leia']);
  check('Leia is not offered', !candidates || !candidates.includes('princess-leia'),
    `candidates=${JSON.stringify(candidates)}`);
}

console.log('\n[ an un-ringed leader IS still a candidate ]');
{
  const G = board(682);
  const { candidates } = offer(G, ['princess-leia']);
  check('Leia is offered when she wears nothing', !!candidates && candidates.includes('princess-leia'),
    `candidates=${JSON.stringify(candidates)} — the fix must not block ordinary targets`);
}

console.log('\n[ mixed: only the un-ringed leader survives ]');
{
  const G = board(683, { 'princess-leia': 'r2d2' });
  const { candidates } = offer(G, ['princess-leia', 'mon-mothma']);
  check('ringed Leia filtered out', !!candidates && !candidates.includes('princess-leia'),
    `candidates=${JSON.stringify(candidates)}`);
  check('un-ringed Mon Mothma kept', !!candidates && candidates.includes('mon-mothma'),
    `candidates=${JSON.stringify(candidates)}`);
}

console.log('\n[ an existing bounty still excludes, as before ]');
{
  const G = board(684, { 'princess-leia': 'bounty' });
  const { candidates } = offer(G, ['princess-leia']);
  check('already-bountied leader is not re-offered',
    !candidates || !candidates.includes('princess-leia'), `candidates=${JSON.stringify(candidates)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
