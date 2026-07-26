// #637 — "Rare instance of having 2 captured leaders in the same system. Homing
// beacon was successful, but I was forced to release the frozen leader instead
// of the non-frozen leader." (Reporter played Empire.)
//
// Homing Beacon is an IMPERIAL mission attempted against a captured leader, so
// it is TWO decisions owned by DIFFERENT players:
//   1. WHICH captive is released  -> the EMPIRE (it is their mission; the same
//      ownership Carbon Freezing already has, worded identically)
//   2. WHERE that leader is placed -> the REBEL ("The Rebel player must place
//      this leader in any system in the Rebel base's region")
// Both used to be bundled into one Rebel-owned HomingBeaconPlace choice, so the
// Empire lost a pick that is theirs. A fix that correctly moved the SYSTEM
// choice to the Rebel had swept the LEADER choice along with it.
//
// Run: node scripts/test-homing-beacon-owner-637.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const M = await import('../src/engine/mechanics.ts');
const { getChoiceResolver } = await import('../src/engine/choices.ts');
const { pendingChoiceOwner } = await import('../src/engine/choiceOwner.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const registry = await import('../src/engine/handlers/registry.ts');
const ctxFor = (sysId) => ({
  actorSide: 'Empire', card: { kind: 'mission', id: 'homing-beacon' },
  targetSystemId: sysId, leaderIds: [], pendingChoice: null, handlerState: null, paused: false,
});

const mkGame = () => {
  const G = createGame(data, { seed: 4, autoSetupUnits: true, expansion: { enabled: true, roteUnits: true } });
  G.phase = 'Command';
  return G;
};
/** Put a Rebel leader on the board at `sysId` and capture them there. An
 *  Imperial unit must be present or captureLeader's "no Imperial units ->
 *  rescued" check frees them immediately. */
const captureAt = (G, leaderId, sysId, ring) => {
  (G.rebel.leadersOnBoard[sysId] ??= []).push(leaderId);
  M.captureLeader(G, leaderId, ring);
  const e = G.empire.capturedLeaders.find((c) => c.leaderId === leaderId);
  if (e) e.systemId = sysId;
};
/** Two captives in ONE system — the #637 board. This is only reachable because
 *  the Empire has a single 'captured' ring (RR p.3: capturing a second leader
 *  rescues the first), so the pair must be one CARBONITE plus one captured.
 *  That is precisely why the reporter called it a rare instance. */
const setupTwoCaptives = (G, sysId) => {
  const rebels = Object.values(G.catalog.leaders).filter((l) => l.side === 'Rebel').slice(0, 2);
  G.map.systems[sysId].units.push({ instanceId: 'imp-guard', typeId: 'stormtrooper', side: 'Empire', damage: 0 });
  captureAt(G, rebels[0].id, sysId, 'carbonite');
  captureAt(G, rebels[1].id, sysId, 'captured');
  return { frozenId: rebels[0].id, freeId: rebels[1].id };
};

console.log('[ #637 — the Empire picks WHICH captive Homing Beacon releases ]');
{
  const G = mkGame();
  const SYS = G.rebelBaseSystemId ?? Object.keys(G.map.systems)[0];
  const { frozenId, freeId } = setupTwoCaptives(G, SYS);
  check('two captives staged in one system', (G.empire.capturedLeaders ?? []).length === 2);

  const handler = registry.get('homing-beacon');
  check('homing-beacon handler is registered', !!handler);
  handler(G, ctxFor(SYS));

  const pc = G.pendingChoice;
  check('a choice was raised', !!pc, 'no pendingChoice');
  check('it is the generic target pick, not the Rebel placement',
    pc?.kind === 'Choice' && pc.tag === 'homing-beacon-target', `got ${pc?.kind}/${pc?.tag}`);
  check('the EMPIRE owns it', pc?.side === 'Empire', `owner=${pc?.side}`);
  // pendingChoiceOwner is a predicate (G, side) -> boolean. The Empire must own
  // it and the Rebel must NOT, or the wrong player is prompted / the online
  // currentActor hands the turn to the wrong seat.
  check('choiceOwner says the Empire owns it, and the Rebel does not',
    pendingChoiceOwner(G, 'Empire') === true && pendingChoiceOwner(G, 'Rebel') === false,
    `empire=${pendingChoiceOwner(G, 'Empire')} rebel=${pendingChoiceOwner(G, 'Rebel')}`);
  check('both captives are offered', (pc?.candidates ?? []).length === 2, `${(pc?.candidates ?? []).length} candidates`);

  // The Empire releases the NON-frozen one — the pick #637's reporter wanted.
  const r = phases.resolveGenericChoice(G, [freeId]);
  check('the Empire\'s pick resolves', r.ok, r.reason);
  const pc2 = G.pendingChoice;
  check('the Rebel now owns the PLACEMENT', pc2?.kind === 'HomingBeaconPlace' && pc2.side === 'Rebel', `got ${pc2?.kind}/${pc2?.side}`);
  check('the placement is locked to the leader the Empire chose',
    pc2?.leaderCandidates?.length === 1 && pc2.leaderCandidates[0] === freeId,
    `leaderCandidates=${JSON.stringify(pc2?.leaderCandidates)}`);
  check('the Rebel still has a real choice of systems', (pc2?.systemCandidates ?? []).length > 1);

  // Finish it: the released leader leaves captivity, the frozen one stays put.
  const sysPick = pc2.systemCandidates[0];
  const r2 = phases.resolveHomingBeaconPlace(G, freeId, sysPick);
  check('placement resolves', r2.ok, r2.reason);
  const stillCaptive = (G.empire.capturedLeaders ?? []).map((c) => c.leaderId);
  check('the released leader is no longer captive', !stillCaptive.includes(freeId));
  check('the FROZEN leader was NOT released', stillCaptive.includes(frozenId), `captives=${JSON.stringify(stillCaptive)}`);
}

console.log('[ one eligible captive — no pointless prompt ]');
{
  const G = mkGame();
  const SYS = G.rebelBaseSystemId ?? Object.keys(G.map.systems)[0];
  const only = Object.values(G.catalog.leaders).find((l) => l.side === 'Rebel');
  G.map.systems[SYS].units.push({ instanceId: 'imp-guard2', typeId: 'stormtrooper', side: 'Empire', damage: 0 });
  captureAt(G, only.id, SYS, 'captured');
  const handler = registry.get('homing-beacon');
  handler(G, ctxFor(SYS));
  const pc = G.pendingChoice;
  check('skips straight to the Rebel placement', pc?.kind === 'HomingBeaconPlace' && pc.side === 'Rebel', `got ${pc?.kind}/${pc?.side}`);
}

console.log('[ the generic-choice resolver is registered ]');
{
  check('homing-beacon-target has a resolver (no soft-lock on submit)',
    !!getChoiceResolver('homing-beacon-target'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
