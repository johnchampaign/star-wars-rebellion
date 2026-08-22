// Player report #735 — "Confirm that subversion dialog works as intended.
// Subversion was NOT run intentionally at bespin in dialog, but fired per log."
//
// They were right, and it was an ONLINE-only bug. Subversion is a RAW "may"
// (#311), so the modal deliberately offers two separate buttons — plain
// "Oppose" and "Oppose + Subversion" — and hotseat threads that choice into
// resolveOpposition's third argument.
//
// The online path did not. `makeOnlinePhases` shadows the engine namespace and
// its resolveOpposition wrapper took only (G, opposerLeaderId), silently
// dropping the flag the modal passed. The action then reached the server
// without it, and the adapter called the engine with the argument omitted —
// falling through to the back-compat default of TRUE. So pressing plain
// "Oppose" in an online game revealed the card, relocated the assigned
// leaders and spent a one-shot mission the player meant to keep.
//
// This file pins the whole chain: modal -> action -> adapter -> engine.
// Run: node scripts/test-subversion-online-735.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const { makeOnlinePhases } = await import('../src/online/onlineEngine.ts');

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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

/** Same fixture as test-subversion-optional-311.mjs: Rebel holds Subversion
 *  with a leader on it, Empire reveals a mission, Rebel gets OpposeMission. */
function setupOpposition(seed) {
  const G = createGame(data, opts(seed));
  G.rebel.missionHand = ['subversion-new-rebel'];
  phases.assignLeader(G, 'Rebel', 'subversion-new-rebel', ['general-rieekan']);
  phases.skipAssignment(G, 'Rebel');
  phases.assignLeader(G, 'Empire', 'rule-by-fear', ['emperor-palpatine']);
  phases.skipAssignment(G, 'Empire');
  let guard = 0;
  while (G.phase === 'Assignment' && guard++ < 10) {
    if (G.pendingChoice?.kind === 'FalseOrdersWindow') { phases.resolveFalseOrders(G, null); continue; }
    break;
  }
  const imperialSys = Object.entries(G.map.systems).find(([, s]) =>
    (s.loyalty === 'imperial' || s.subjugated) && s.units.some((u) => u.side === 'Empire'))?.[0];
  G.currentPlayer = 'Empire';
  phases.revealMission(G, 'Empire', 'rule-by-fear', imperialSys);
  return G;
}

const firedSubversion = (G, since) =>
  G.turnLog.slice(since).some((e) => e.kind === 'subversion-trigger');
/** applyAction clones — the post-action state is the RETURN value. */
const applyOnline = (G, action) => rebellionAdapter.applyAction(G, action, 'Rebel');

console.log('\n[ #735 the online wrapper carries the player\'s choice into the action ]');
{
  const sent = [];
  const online = makeOnlinePhases(async (a) => { sent.push(a); }, () => true);
  // The modal calls onResolve(leaderId, useSubversion); PlayTab forwards both.
  // makeAct drops a submit while another is in flight, so let each settle.
  online.resolveOpposition(null, null, false);
  await new Promise((r) => setTimeout(r, 0));
  online.resolveOpposition(null, null, true);
  await new Promise((r) => setTimeout(r, 0));
  check('two actions were submitted', sent.length === 2, `sent=${sent.length}`);
  check('plain "Oppose" submits useSubversion:false',
    sent[0]?.kind === 'resolveOpposition' && sent[0]?.useSubversion === false,
    JSON.stringify(sent[0]));
  check('"Oppose + Subversion" submits useSubversion:true',
    sent[1]?.useSubversion === true, JSON.stringify(sent[1]));
}

console.log('\n[ #735 the adapter honours it — declining does NOT spend the card ]');
{
  const G0 = setupOpposition(41);
  const before = G0.turnLog.length;
  const G = applyOnline(G0, { kind: 'resolveOpposition', opposerLeaderId: null, useSubversion: false });
  check('no subversion-trigger in the log — this is the reported symptom',
    !firedSubversion(G, before));
  check('the assigned leader stayed on the Subversion mission',
    G.rebel.leadersOnMissions.some((m) => m.missionId === 'subversion-new-rebel'));
  check('and the one-shot card was not discarded',
    !G.rebel.missionDiscard.includes('subversion-new-rebel'));
}

console.log('\n[ opting IN through the same path still works ]');
{
  const G0 = setupOpposition(42);
  const before = G0.turnLog.length;
  const G = applyOnline(G0, { kind: 'resolveOpposition', opposerLeaderId: null, useSubversion: true });
  check('subversion-trigger fires when the player asked for it',
    firedSubversion(G, before));
  check('the card is spent', G.rebel.missionDiscard.includes('subversion-new-rebel'));
}

console.log('\n[ an action with the flag ABSENT must not spend the card either ]');
{
  // Belt and braces: an old queued action, a replay of a pre-fix log, or any
  // future caller that forgets the field must fail SAFE. Spending a one-shot
  // card is the irreversible direction; keeping it is not.
  const G0 = setupOpposition(43);
  const before = G0.turnLog.length;
  const G = applyOnline(G0, { kind: 'resolveOpposition', opposerLeaderId: null });
  check('omitted flag is treated as "no" by the adapter', !firedSubversion(G, before));
  check('card kept', !G.rebel.missionDiscard.includes('subversion-new-rebel'));
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
