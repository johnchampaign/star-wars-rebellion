// Star Wars: Rebellion adapter for the self-play analytics pipeline.
// Turns one finished game (turnLog + snapshots) into the per-game strategic
// dimensions, and provides the radar/heatmap specs the analyzer renders.
//
// DESIGN NOTE: this game is ASYMMETRIC, so winners-vs-losers comparisons are
// only meaningful WITHIN a side (Rebel winners vs Rebel losers, Empire winners
// vs Empire losers) — one blended radar would average opposing strategies
// into noise. Hence two radar specs.

import { FEATURE_NAMES } from '../../../src/play/evalFeatures.ts';

const F_BASE_CANDIDATES = FEATURE_NAMES.indexOf('baseCandidates');

/** Per-game dimensions, all finite numbers, all rate-style (per round where it
 *  matters) so games of different lengths compare fairly. */
export function computeDims(game) {
  const { turnLog, snapshots, rounds } = game;
  const r = Math.max(1, rounds);
  const count = (pred) => turnLog.filter(pred).length;

  // --- Rebel ---
  const rebelLoyaltyFlips = count((e) => e.kind === 'gain-loyalty' && e.side === 'Rebel');
  const rebelObjectiveRep = turnLog
    .filter((e) => e.kind === 'play-objective')
    .reduce((a, e) => a + (e.payload?.reputation ?? 1), 0);
  const rebelBuilds = count((e) => e.kind === 'build-queue' && e.side === 'Rebel');
  const rebelCombats = count((e) => e.kind === 'combat-begin' && e.payload?.attackerSide === 'Rebel');
  const rebelAssignments = count((e) => e.side === 'Rebel' && (e.kind === 'assign-leader' || e.kind === 'activate-system'));
  const rebelRelocations = count((e) => e.kind === 'rapid-mobilization-base-established');
  const revealEvent = turnLog.find((e) => e.kind === 'reveal-base');
  const roundsBaseHidden = revealEvent ? revealEvent.turn : rounds;

  // --- Empire ---
  const empSubjugations = count((e) => e.kind === 'subjugated');
  const empCombats = count((e) => e.kind === 'combat-begin' && e.payload?.attackerSide === 'Empire');
  const empPasses = count((e) => e.kind === 'pass' && e.side === 'Empire');
  const empAssignments = count((e) => e.side === 'Empire' && (e.kind === 'assign-leader' || e.kind === 'activate-system'));
  // Base assaults = Empire-initiated combats AT the revealed base's system
  // (reveal-base carries the systemId; combat-begin carries systemId+attacker).
  const baseSystemId = revealEvent?.payload?.systemId;
  const empBaseAssaults = baseSystemId
    ? count((e) => e.kind === 'combat-begin' && e.payload?.attackerSide === 'Empire'
        && e.payload?.systemId === baseSystemId && e.turn >= revealEvent.turn)
    : 0;
  // Never-found must read WORSE than any real find on a lower-is-better dim.
  // (First cut used 0 = never, which reads as "found instantly" and made
  // losers — who mostly never find it — look FASTER than winners.)
  const findTurn = revealEvent ? revealEvent.turn : rounds + 1;
  // Hunt progress from the snapshot feature (Rebel-signed, so positive).
  const firstCand = snapshots[0]?.rebel?.[F_BASE_CANDIDATES] ?? 0;
  const lastCand = snapshots[snapshots.length - 1]?.rebel?.[F_BASE_CANDIDATES] ?? firstCand;
  const candidatesRuledOut = Math.max(0, firstCand - lastCand);

  return {
    // Rebel radar dims
    rebelLoyaltyPerRound: rebelLoyaltyFlips / r,
    rebelObjectiveRep: rebelObjectiveRep,
    rebelBuildsPerRound: rebelBuilds / r,
    rebelCombatsPerRound: rebelCombats / r,
    rebelAssignsPerRound: rebelAssignments / r,
    rebelRelocations: rebelRelocations,
    roundsBaseHidden: roundsBaseHidden,
    // Empire radar dims
    empSubjugationsPerRound: empSubjugations / r,
    empCandidatesRuledOutPerRound: candidatesRuledOut / r,
    empFindTurn: findTurn,
    empBaseAssaults: empBaseAssaults,
    empCombatsPerRound: empCombats / r,
    empPassesPerRound: empPasses / r,
    empAssignsPerRound: empAssignments / r,
  };
}

/** Radar chart specs: which dims, per side. `invert` marks dims where LOWER is
 *  better for that side (rendered inverted so "bigger polygon = playing the
 *  side's game well" stays readable). */
export const RADARS = [
  {
    id: 'rebel',
    title: 'Rebel: winners vs losers',
    dims: [
      { key: 'rebelLoyaltyPerRound', label: 'loyalty/rnd' },
      { key: 'rebelObjectiveRep', label: 'objective rep' },
      { key: 'rebelBuildsPerRound', label: 'builds/rnd' },
      { key: 'rebelCombatsPerRound', label: 'attacks/rnd' },
      { key: 'rebelAssignsPerRound', label: 'leader use/rnd' },
      { key: 'rebelRelocations', label: 'relocations' },
      { key: 'roundsBaseHidden', label: 'rounds hidden' },
    ],
  },
  {
    id: 'empire',
    title: 'Empire: winners vs losers',
    dims: [
      { key: 'empSubjugationsPerRound', label: 'subjugations/rnd' },
      { key: 'empCandidatesRuledOutPerRound', label: 'hunt intel/rnd' },
      { key: 'empFindTurn', label: 'find turn', invert: true },
      { key: 'empCombatsPerRound', label: 'attacks/rnd' },
      { key: 'empPassesPerRound', label: 'passes/rnd', invert: true },
      { key: 'empAssignsPerRound', label: 'leader use/rnd' },
      { key: 'empBaseAssaults', label: 'base assaults' },
    ],
  },
];

/** Heatmap cell extraction: system-keyed activity counts from the action list. */
export function heatmapCells(records, side, kinds) {
  const cells = new Map();
  for (const rec of records) {
    for (const a of rec.actions) {
      if (a.side !== side || !kinds.includes(a.kind) || !a.target) continue;
      cells.set(a.target, (cells.get(a.target) ?? 0) + 1);
    }
  }
  return cells;
}

/** Card-frequency extraction (mission reveals) for the frequency grids. */
export function cardFrequencies(records, side) {
  const freq = new Map();
  for (const rec of records) {
    for (const a of rec.actions) {
      if (a.side !== side || a.kind !== 'reveal' || !a.id) continue;
      freq.set(a.id, (freq.get(a.id) ?? 0) + 1);
    }
  }
  return freq;
}
