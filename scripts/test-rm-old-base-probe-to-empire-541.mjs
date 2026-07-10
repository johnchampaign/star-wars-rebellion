// #541 — when the Rebel relocates its base via Rapid Mobilization, RAW (Learn to
// Play p.12) says the OLD base's probe card is GIVEN TO THE IMPERIAL PLAYER (the
// old location is revealed as the vacated base). Our code wrongly shuffled it back
// into the probe deck, so the Empire never learned the old location — and the
// player saw the old garrison "appear" at the vacated system with no explanation.
// Now the old base probe goes to the Empire's probe hand; only the UNCHOSEN drawn
// cards return to the deck; the chosen new-base card stays out (marks the base).
// Run: node scripts/test-rm-old-base-probe-to-empire-541.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ #541 — old base probe card is given to the Empire on RM relocation ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  const oldBase = G.rebelBaseSystemId;
  const probeOf = (sid) => Object.values(G.catalog.probes).find((p) => p.systemId === sid)?.id;
  const oldProbe = probeOf(oldBase);
  // Total probe cards in existence (conservation check across deck + hand + out).
  const totalProbes = Object.keys(G.catalog.probes).length;
  const oldProbeInHandBefore = (G.empire.probeHand ?? []).includes(oldProbe);

  // Drive the base-pick resolver directly: draw 4, choose a legal new base that is
  // NOT the old base and NOT the Empire's.
  const drawn = G.probeDeck.slice(0, 4);
  // Ensure at least one drawn card is a legal base (rebel/neutral, no imperial units).
  const legal = drawn.map((pid) => G.catalog.probes[pid]?.systemId).find((sid) => {
    const ss = G.map.systems[sid];
    return ss && sid !== oldBase && ss.loyalty !== 'imperial' && !ss.units.some((u) => u.side === 'Empire');
  });
  if (!legal) { console.log('  (seed produced no legal drawn base — skipping)'); process.exit(0); }
  G.probeDeck = G.probeDeck.slice(4);
  G.pendingChoice = { kind: 'RapidMobilizationBasePick', side: 'Rebel', probeSystemIds: drawn.map((pid) => G.catalog.probes[pid].systemId), drawnProbeIds: drawn };

  const r = phases.resolveRapidMobilizationBasePick(G, legal);
  check('relocation resolves ok', r.ok, r.reason);
  check('base moved to the chosen system', G.rebelBaseSystemId === legal, `base=${G.rebelBaseSystemId}`);

  const empHand = G.empire.probeHand ?? [];
  check('OLD base probe is now in the Empire\'s hand', empHand.includes(oldProbe), `oldProbe=${oldProbe} hand=${JSON.stringify(empHand)}`);
  check('OLD base probe is NOT back in the deck', !G.probeDeck.includes(oldProbe));
  const newProbe = probeOf(legal);
  check('NEW base probe stays OUT (marks the hidden base)', !G.probeDeck.includes(newProbe) && !empHand.includes(newProbe), `newProbe=${newProbe}`);
  // Conservation: every probe card is accounted for exactly once (deck + empire hand + out).
  const outCount = totalProbes - G.probeDeck.length - empHand.length;
  check('probe-card conservation holds (no dupes/losses)', new Set([...G.probeDeck, ...empHand]).size === G.probeDeck.length + empHand.length && outCount >= 1,
    `deck=${G.probeDeck.length} hand=${empHand.length} out=${outCount} total=${totalProbes}`);
  // The RAW invariant: the old base card was OUT (not held) before, and is now in
  // the Empire's hand — i.e. it was newly given to the Empire, not already there.
  check('old base card was newly GIVEN to the Empire (not held before)', !oldProbeInHandBefore && empHand.includes(oldProbe), `before=${oldProbeInHandBefore}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
