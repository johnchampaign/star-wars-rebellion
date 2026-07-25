// #641 — "Rapid Mobilization does not show all probes, just eligible probes.
// Per rules should show all."
//
// The reporter was right. RR p.11 "Establishing a New Base":
//   "the Rebel player draws the top four cards of the probe deck. He may choose
//    one of those cards to become the new base location."
// and separately:
//   "The Rebel player cannot establish a base in a system that has Imperial
//    loyalty, Imperial units, or a destroyed system marker."
//
// So the Rebel LOOKS at all 4 (or 8) drawn cards — the restriction is on which
// one may be CHOSEN, not on which ones are seen. The pick modal was rendering
// only `probeSystemIds` (the pre-filtered eligible list), hiding cards the
// player had legitimately drawn. This asserts the engine hands the UI everything
// it needs to show all of them, plus a per-system reason for the greyed rows.
//
// Run: node scripts/test-rm-shows-all-probes-641.mjs
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

console.log('[ #641 — the block-reason helper matches the three RAW restrictions ]');
{
  const G = createGame(data, { seed: 5, autoSetupUnits: true });
  const sids = Object.keys(G.map.systems);
  // Find a system we can freely mutate into each blocked state.
  const sid = sids.find((s) => !G.catalog.systems[s]?.isRemote && s !== 'rebel-base-space');
  const ss = G.map.systems[sid];
  const saved = { destroyed: ss.destroyed, loyalty: ss.loyalty, units: [...ss.units] };

  ss.destroyed = false; ss.loyalty = 'neutral'; ss.units = [];
  check('clean neutral system → eligible (null reason)',
    phases.rebelBaseCandidateBlockReason(G, sid) === null,
    `got ${phases.rebelBaseCandidateBlockReason(G, sid)}`);

  ss.loyalty = 'imperial';
  check('Imperial loyalty → blocked with a reason',
    phases.rebelBaseCandidateBlockReason(G, sid) === 'Imperial loyalty',
    `got ${phases.rebelBaseCandidateBlockReason(G, sid)}`);

  ss.loyalty = 'neutral'; ss.units = [{ instanceId: 'x1', side: 'Empire', typeId: 'stormtrooper' }];
  check('Imperial units present → blocked with a reason',
    phases.rebelBaseCandidateBlockReason(G, sid) === 'Imperial units present',
    `got ${phases.rebelBaseCandidateBlockReason(G, sid)}`);

  ss.units = []; ss.destroyed = true;
  check('destroyed system → blocked with a reason',
    phases.rebelBaseCandidateBlockReason(G, sid) === 'destroyed system',
    `got ${phases.rebelBaseCandidateBlockReason(G, sid)}`);

  Object.assign(ss, saved);
}

console.log('\n[ #641 — the base pick carries EVERY drawn probe, not just eligible ones ]');
{
  // Search seeds for a draw that contains at least one ineligible system — that
  // is exactly the case the old UI silently swallowed.
  let found = null;
  for (let seed = 1; seed <= 60 && !found; seed++) {
    const G = createGame(data, { seed, autoSetupUnits: true });
    G.phase = 'Command';
    // Sabotage-free way to guarantee a mixed draw: make a chunk of the map
    // Imperial so some drawn probes are certain to be ineligible.
    const sids = Object.keys(G.map.systems).filter((s) => s !== 'rebel-base-space' && s !== G.rebelBaseSystemId);
    for (const s of sids.slice(0, Math.floor(sids.length / 2))) G.map.systems[s].loyalty = 'imperial';

    G.pendingChoice = { kind: 'RapidMobilizationBranch', side: 'Rebel', twoLeaders: false, baseRevealed: false };
    G.pendingRapidMobilizations = [{ twoLeaders: false }];
    const r = phases.resolveRapidMobilizationBranch(G, 'establish-base');
    if (!r.ok) continue;
    const pc = G.pendingChoice;
    if (pc?.kind !== 'RapidMobilizationBasePick') continue;         // all-blocked path
    const drawnSystems = (pc.drawnProbeIds ?? [])
      .map((pid) => G.catalog.probes[pid]?.systemId).filter(Boolean);
    const eligible = pc.probeSystemIds ?? [];
    if (drawnSystems.length > eligible.length) found = { G, pc, drawnSystems, eligible, seed };
  }
  check('found a draw with at least one ineligible probe', !!found,
    'no mixed draw in 60 seeds — widen the search');

  if (found) {
    const { G, pc, drawnSystems, eligible } = found;
    check('drawnProbeIds is present on the choice', (pc.drawnProbeIds ?? []).length > 0, 'missing');
    check('drawn count is the full RAW draw (4 with one leader)',
      (pc.drawnProbeIds ?? []).length === 4, `got ${(pc.drawnProbeIds ?? []).length}`);
    check('drawn list is a strict superset of the eligible list',
      drawnSystems.length > eligible.length && eligible.every((s) => drawnSystems.includes(s)),
      `drawn=${drawnSystems.length} eligible=${eligible.length}`);
    check('every hidden-before system now has a displayable reason',
      drawnSystems.filter((s) => !eligible.includes(s))
        .every((s) => typeof phases.rebelBaseCandidateBlockReason(G, s) === 'string'),
      'an ineligible system returned null');
    check('every eligible system reports NO reason (renders enabled)',
      eligible.every((s) => phases.rebelBaseCandidateBlockReason(G, s) === null),
      'an eligible system reported a block reason');
  }
}

console.log('\n[ #641 — the all-blocked notice names the systems it drew ]');
{
  // When NO drawn card is legal the engine can't post a pick (RR: "the Rebel
  // player cannot establish a new base this round"), so the drawn cards are
  // reported via a notice instead. That notice is the only place the player
  // sees them, so it has to name them.
  let rm = null;
  for (let seed = 1; seed <= 80 && !rm; seed++) {
    const g = createGame(data, { seed, autoSetupUnits: true });
    g.phase = 'Command';
    // Make the WHOLE map Imperial so no drawn probe can ever be legal.
    for (const s of Object.keys(g.map.systems)) {
      if (s !== 'rebel-base-space') g.map.systems[s].loyalty = 'imperial';
    }
    g.pendingChoice = { kind: 'RapidMobilizationBranch', side: 'Rebel', twoLeaders: false, baseRevealed: false };
    g.pendingRapidMobilizations = [{ twoLeaders: false }];
    const r = phases.resolveRapidMobilizationBranch(g, 'establish-base');
    if (!r.ok) continue;
    // Note: pendingChoice is NOT undefined here — finishRapidMobilization lets
    // the phase continue, so it's whatever the next step posted. Detect the
    // all-ineligible path by its notice, not by the absence of a choice.
    rm = (g.pendingNotices ?? g.notices ?? [])
      .find((n) => (n.title ?? '').includes('Rapid Mobilization'));
  }
  check('reached the all-ineligible path (notice emitted)', !!rm, 'never hit it in 80 seeds');
  if (rm) {
    const body = rm.details ?? rm.body ?? rm.text ?? rm.message ?? '';
    check('the notice lists the drawn systems, not just a bare count',
      /You drew: .+\(/.test(body), `details=${JSON.stringify(body).slice(0, 200)}`);
    check('each named system carries its block reason',
      (body.match(/\((Imperial loyalty|Imperial units present|destroyed system)\)/g) ?? []).length >= 1,
      `details=${JSON.stringify(body).slice(0, 200)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
