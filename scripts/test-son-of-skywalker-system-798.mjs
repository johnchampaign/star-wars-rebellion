// Player report #798 — "Seek Yoda didn't trigger." The Rebel held Son of
// Skywalker with Luke standing at Sullust, and Seek Yoda still in the mission
// deck. The printed card (images/Son of Skywalker.png):
//
//   "After you succeed at a mission in this leader's system, search your
//    mission deck for the "Seek Yoda," "Daring Rescue," or "Critical Rescue"
//    card and place it in your hand. Then shuffle your mission deck."
//
// The engine only offered it when Luke was one of the leaders who RESOLVED the
// mission, so another leader's success in Luke's system never triggered it.
//
// Run: node scripts/test-son-of-skywalker-system-798.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

function board({ lukeAt, resolvers, target = 'sullust', stage = 'effect' }) {
  const G = createGame(data, { seed: 798, expansion: { enabled: false } });
  G.rebel.actionHand = ['son-of-skywalker'];
  if (!G.rebel.missionDeck.includes('seek-yoda')) G.rebel.missionDeck.push('seek-yoda');
  G.rebel.missionHand = G.rebel.missionHand.filter((m) => m !== 'seek-yoda');
  for (const k of Object.keys(G.rebel.leadersOnBoard)) {
    G.rebel.leadersOnBoard[k] = G.rebel.leadersOnBoard[k].filter((l) => l !== 'luke-skywalker');
  }
  if (lukeAt) (G.rebel.leadersOnBoard[lukeAt] ??= []).push('luke-skywalker');
  const pm = { resolverSide: 'Rebel', stage, missionId: 'heist', leaderIds: resolvers,
    targetSystemId: target, opposers: [] };
  G.pendingMission = pm;
  return { G, pm };
}

console.log('\n[ Han succeeds at Sullust while Luke stands there (the report) ]');
{
  const { G, pm } = board({ lukeAt: 'sullust', resolvers: ['han-solo'] });
  const posted = phases.maybePostMissionRingTrigger(G, pm);
  check('Son of Skywalker is offered', posted && G.pendingChoice?.kind === 'SonOfSkywalkerOffer',
    `got ${G.pendingChoice?.kind}`);
  check('Seek Yoda is a candidate', G.pendingChoice?.candidates?.includes('seek-yoda'));
}

console.log('\n[ Luke resolving the mission himself still works ]');
{
  const { G, pm } = board({ lukeAt: null, resolvers: ['luke-skywalker'] });
  check('offered', phases.maybePostMissionRingTrigger(G, pm) && G.pendingChoice?.kind === 'SonOfSkywalkerOffer');
}

console.log('\n[ Luke elsewhere, or the mission failed: no offer ]');
{
  const { G, pm } = board({ lukeAt: 'kashyyyk', resolvers: ['han-solo'] });
  phases.maybePostMissionRingTrigger(G, pm);
  check('Luke in another system: not offered', G.pendingChoice?.kind !== 'SonOfSkywalkerOffer');
  const b = board({ lukeAt: 'sullust', resolvers: ['han-solo'], stage: 'failed' });
  phases.maybePostMissionRingTrigger(b.G, b.pm);
  check('failed mission: not offered', b.G.pendingChoice?.kind !== 'SonOfSkywalkerOffer');
}

console.log('\n[ Taking it moves the card to hand ]');
{
  const { G, pm } = board({ lukeAt: 'sullust', resolvers: ['han-solo'] });
  phases.maybePostMissionRingTrigger(G, pm);
  const before = G.rebel.missionDeck.length;
  const r = phases.resolveSonOfSkywalkerOffer(G, 'seek-yoda');
  check('resolves', r.ok, r.reason);
  check('Seek Yoda now in hand, out of the deck',
    G.rebel.missionHand.includes('seek-yoda') && !G.rebel.missionDeck.includes('seek-yoda')
    && G.rebel.missionDeck.length === before - 1);
  check('the action card is spent', !G.rebel.actionHand.includes('son-of-skywalker')
    && G.rebel.actionDiscard.includes('son-of-skywalker'));
}

check('card text matches the printed card',
  /in this leader's system/.test(createGame(data, { seed: 1 }).catalog.actions['son-of-skywalker'].rulesText));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
