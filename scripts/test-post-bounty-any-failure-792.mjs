// @timeout 120000
// #792 (irq7ae, playing Empire): "Jabba the Hutt was doing a mission for
// Imperial Propaganda, and Ackbar opposed ... it failed, then Jabba should have
// triggered Post Bounty on Ackbar."
//
// The printed card (images/Post Bounty.png): "Use after ANY leader fails a
// mission in this leader's system. Attach the bounty ring to any REBEL leader
// that does not have a ring IN THIS SYSTEM." Our transcription read "a leader
// ... 1 un-ringed leader", and the engine only fired after a REBEL mission
// failed, offering only its resolvers. So Jabba's own failed mission, opposed
// by Ackbar standing in his system, offered nothing.
//
// Drives the real flow: Jabba reveals Imperial Propaganda, Ackbar opposes, and
// seeds are scanned until the attempt fails.
// Run: node scripts/test-post-bounty-any-failure-792.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const MISSION = 'imperial-propaganda';

/** Jabba (with Post Bounty in hand) attempts Imperial Propaganda in an Imperial
 *  system; Ackbar opposes from the Rebel pool. Returns the board once the
 *  attempt has resolved, or null if this seed's roll succeeded. */
function failedAttempt(seed, { withCard = true, extraRebelHere = null, ringOnAckbar = null } = {}) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const SYS = Object.keys(G.map.systems).find((id) => G.map.systems[id].loyalty === 'imperial' && !G.catalog.systems[id]?.isCoruscant);
  G.empire.actionHand = withCard ? ['post-bounty'] : [];
  G.rebel.actionHand = []; G.empire.objectiveHand = []; G.rebel.objectiveHand = [];
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== 'jabba');
  if (!G.empire.missionHand.includes(MISSION)) G.empire.missionHand.push(MISSION);
  G.empire.leadersOnMissions.push({ missionId: MISSION, leaderIds: ['jabba'] });
  if (!G.rebel.leaderPool.includes('admiral-ackbar')) G.rebel.leaderPool.push('admiral-ackbar');
  if (ringOnAckbar) M.attachRing(G, 'admiral-ackbar', ringOnAckbar);
  if (extraRebelHere) { G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== extraRebelHere); M.placeLeader(G, 'Rebel', extraRebelHere, SYS); }
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  const r = phases.revealMission(G, 'Empire', MISSION, SYS);
  if (!r.ok) throw new Error(`reveal refused: ${r.reason}`);
  if (G.pendingChoice?.kind !== 'OpposeMission') throw new Error(`no opposition prompt: ${G.pendingChoice?.kind}`);
  phases.resolveOpposition(G, 'admiral-ackbar');
  const failed = (G.turnLog ?? []).some((e) => e.kind === 'mission-roll' && e.payload?.missionId === MISSION && e.payload?.result === 'failure')
    || G.pendingMission?.stage === 'failed';
  return failed ? { G, SYS } : null;
}
function firstFailure(opts) {
  for (let seed = 1; seed < 400; seed++) { const r = failedAttempt(seed, opts); if (r) return { ...r, seed }; }
  return null;
}

console.log('[ the card text matches the printed card ]');
{
  const G = createGame(data, { seed: 1, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const txt = G.catalog.actions['post-bounty']?.rulesText ?? '';
  check('"any leader fails a mission"', /any leader fails a mission/i.test(txt), txt);
  check('"any Rebel leader that does not have a ring in this system"', /any Rebel leader that does not have a ring in this system/i.test(txt), txt);
}

console.log('[ the reported play: Jabba\'s Imperial Propaganda fails against Ackbar ]');
{
  const hit = firstFailure();
  check('found a seed where the opposed attempt fails', !!hit);
  if (hit) {
    const { G, SYS, seed } = hit;
    check('Ackbar is standing in Jabba\'s system after opposing', (G.rebel.leadersOnBoard[SYS] ?? []).includes('admiral-ackbar'), JSON.stringify(G.rebel.leadersOnBoard));
    const pc = G.pendingChoice;
    check('Post Bounty is offered to the Empire', pc?.kind === 'PostBountyOffer' && pc.side === 'Empire', `seed=${seed} choice=${pc?.kind}`);
    check('Ackbar is the candidate', pc?.kind === 'PostBountyOffer' && pc.candidates.includes('admiral-ackbar'), JSON.stringify(pc?.candidates));
    check('Jabba (an Imperial leader) is not a candidate', pc?.kind === 'PostBountyOffer' && !pc.candidates.includes('jabba'));
    const r = phases.resolvePostBountyOffer(G, 'admiral-ackbar');
    check('the Empire can bounty Ackbar', r.ok, r.reason);
    check('Ackbar now carries the bounty ring', (G.leaderAttachments?.['admiral-ackbar'] ?? []).includes('bounty'));
    check('Post Bounty went to the discard pile', !G.empire.actionHand.includes('post-bounty') && G.empire.actionDiscard.includes('post-bounty'));
    check('the failed mission was cleaned up and play moved on', !G.pendingMission && !G.pendingChoice, `pm=${!!G.pendingMission} choice=${G.pendingChoice?.kind}`);
  }
}

console.log('[ "any Rebel leader ... in this system", not just the opposer ]');
{
  const hit = firstFailure({ extraRebelHere: 'mon-mothma' });
  const pc = hit?.G.pendingChoice;
  check('a Rebel leader already in the system is offered too', pc?.kind === 'PostBountyOffer' && pc.candidates.includes('mon-mothma') && pc.candidates.includes('admiral-ackbar'), JSON.stringify(pc?.candidates));
}

console.log('[ controls ]');
{
  const noCard = firstFailure({ withCard: false });
  check('without Post Bounty in hand, nothing is offered', !!noCard && noCard.G.pendingChoice?.kind !== 'PostBountyOffer', noCard?.G.pendingChoice?.kind);
  const ringed = firstFailure({ ringOnAckbar: 'r2d2' });
  check('a Rebel leader who already has a ring is not offered (#681)', !!ringed && ringed.G.pendingChoice?.kind !== 'PostBountyOffer', JSON.stringify(ringed?.G.pendingChoice));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
