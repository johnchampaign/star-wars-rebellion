// #626 — The Millennium Falcon card reads: "Attach the Millennium Falcon ring
// to this leader. After you succeed at a mission in the Millennium Falcon's
// system, discard this ring to rescue 1 captured leader in this system."
//
// The engine used to trigger off "the card is in hand AND Han or Chewie is one
// of the mission's leaders", with no ring at all — so a Chewbacca mission fired
// a ring the player had placed on Han, in a system Han wasn't even in.
//
// Run: node scripts/test-falcon-ring-626.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
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

const SYS = 'geonosis';

/** Rebel holds the Falcon card with the ring on `bearer`; a captured Rebel
 *  leader sits at SYS; `resolver` just succeeded at a mission there, and
 *  `bearerAt` is where the ring bearer is standing (null = nowhere). */
function scenario({ bearer, resolver, bearerAt }) {
  const G = createGame(data, { seed: 11, forcedBaseSystem: 'sullust' });
  G.rebel.actionHand = ['the-milleninium-falcon'];
  G.leaderAttachments = { [bearer]: ['falcon'] };
  G.rebel.leadersOnBoard = {};
  if (bearerAt) G.rebel.leadersOnBoard[bearerAt] = [bearer];
  const at = G.rebel.leadersOnBoard[SYS] ?? [];
  if (!at.includes(resolver)) G.rebel.leadersOnBoard[SYS] = [...at, resolver];
  // A captured Rebel leader to rescue, held at SYS.
  G.empire.capturedLeaders = [{ leaderId: 'general-madine', systemId: SYS, ring: 'captured' }];
  G.pendingMission = {
    missionId: 'sabotage', resolverSide: 'Rebel', targetSystemId: SYS,
    leaderIds: [resolver], stage: 'effect', success: true,
  };
  return G;
}

/** Did the Falcon offer post for this game state? */
function offered(G) {
  phases.maybePostMissionRingTrigger(G, G.pendingMission);
  return G.pendingChoice?.kind === 'FalconOffer';
}

console.log('\n[ #626 the ring only fires where its BEARER is standing ]');
{
  // Reported case: ring on Han, Chewie runs the mission, Han is elsewhere.
  const G = scenario({ bearer: 'han-solo', resolver: 'chewbacca', bearerAt: 'naboo' });
  check("ring on Han + Han not in the system → no offer",
    !offered(G), `pendingChoice=${G.pendingChoice?.kind}`);
}
{
  // Same ring, but Han IS in the system — the mission's own resolver is
  // irrelevant, the card only cares where the Falcon is.
  const G = scenario({ bearer: 'han-solo', resolver: 'chewbacca', bearerAt: SYS });
  check('ring on Han + Han IS in the system → offer posts', offered(G),
    `pendingChoice=${G.pendingChoice?.kind}`);
}
{
  // Ring on Chewie, Chewie runs the mission there.
  const G = scenario({ bearer: 'chewbacca', resolver: 'chewbacca', bearerAt: SYS });
  check('ring bearer runs the mission in their own system → offer posts', offered(G),
    `pendingChoice=${G.pendingChoice?.kind}`);
}

console.log('\n[ #626 using the ring discards it (once per game) ]');
{
  const G = scenario({ bearer: 'han-solo', resolver: 'han-solo', bearerAt: SYS });
  check('offer posted', offered(G));
  if (G.pendingChoice?.kind === 'FalconOffer') {
    const r = phases.resolveFalconOffer(G, 'general-madine');
    check('rescue accepted', r.ok, r.reason);
    check('the ring came off Han', !M.findRingHolder(G, 'falcon'),
      `holder=${M.findRingHolder(G, 'falcon')}`);
    check('the card left the Rebel hand',
      !G.rebel.actionHand.includes('the-milleninium-falcon'));
    check('the captured leader was rescued',
      !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'general-madine'));
  }
}

console.log('\n[ #626 recruiting off the card places the ring on that leader ]');
{
  const G = createGame(data, { seed: 12, forcedBaseSystem: 'sullust' });
  G.rebel.actionHand = [];
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== 'han-solo' && l !== 'chewbacca');
  G.leaderAttachments = {};
  G.pendingChoice = {
    kind: 'RecruitLeaderPick', side: 'Rebel',
    cardId: 'the-milleninium-falcon', candidates: ['han-solo', 'chewbacca'],
  };
  phases.resolveRecruitLeaderPick(G, 'chewbacca');
  check('ring landed on the leader actually recruited',
    M.findRingHolder(G, 'falcon') === 'chewbacca',
    `holder=${M.findRingHolder(G, 'falcon')}`);
  check('Han did NOT get the ring',
    !(G.leaderAttachments?.['han-solo'] ?? []).includes('falcon'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
