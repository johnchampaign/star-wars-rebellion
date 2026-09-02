# Imitation + planning: the opponent-AI roadmap (2026-08-31)

John's call after the Fable 5.1 review: pursue **imitation from the recorded
human games** and a **plan layer**, combined so the plan conditions the
imitation and the search verifies tactics. This file is the working record.

## Why this direction

- 671 recorded human-vs-AI games at a **96.6% human win rate** — ~350 games of
  winning Empire play, ~320 of winning Rebel play, every decision captured.
  Nothing had been trained on it.
- The AI's recurring failures are not tactical: no plan (#539 cluster), and
  candidate generation that never proposes the move a human makes (below).

## Step 1 — DONE: the exact-state dataset and the position-level instrument

`scripts/mine-human-decisions.mjs` replays each archived round from its
turn-start snapshot to the first Command decision by answering every choice
the engine posts with the recorded resolution (deploy, build, recruit, ring,
hand-trim, pool cap, assignment incl. the #76 undo and action-card plays).
Rounds where an unmapped choice had to be answered by the heuristic are
flagged `approx` and excluded from measurement.

| | |
|---|---|
| games | 434 |
| rounds replayed to Command | 2,198 exact + 342 approx (148 failed, 5%) |
| samples (human acts first from an exact state) | **1,119** |

v1 limits: only the human's FIRST Command decision of a round, and only when
the human acts first — so all 1,119 samples are **human-Rebel** (the Rebel
opens Command). Human-Empire decisions need the AI Rebel's opening actions
replayed first (combat/opposition resolvers, ~100 kinds): that is v2.

`scripts/eval-candidate-coverage.mjs` regenerates candidates for every sample
with the CURRENT generator and reports whether the human's move is among
them. It runs in seconds on 1,119 real positions — the instrument the win-rate
A/B never was (see docs/ab-levers.md: an 8pp effect needs ~600 games/arm).

## The finding: candidate generation is a hard ceiling

At the shipped generator the human's move is **generated 31% of the time**
and is in the heuristic's top-3 **16%**, top-1 **3%**. The misses are one
defect: the generator emits exactly ONE target per mission and ONE per leader.

| miss class | share |
|---|---|
| reveal: right mission, other target | 85% of reveal misses |
| activation: right leader, other target | 74% of activation misses |

MCTS can only choose among candidates, so no search budget fixes this.

### Width alone is not the answer

`SWR_CAND_K` (default 1) emits the top-K targets per mission and per leader.
Measured on the dataset:

| K | generated | in MCTS root (top-12 by heuristic) | heuristic top-3 |
|---|---|---|---|
| 1 | 31% | 31% | 16% |
| 2 | 44% | **42%** | 11% |
| 3 | 53% | 39% | 7% |
| 4 | 60% | 34% | 7% |

Generation doubles, but what the search actually SEES peaks at K=2 and then
falls: the heuristic cannot rank the human's target above the alternatives it
now emits, so the root's top-12 cut drops it. **Width gives the search the
option; a learned ranker is what makes it find it.** K stays 1 until then.
(Guarded: `test-cand-width` pins K=1 ≡ legacy and K>1 ⊇ K=1 with scores
preserved; `test-mine-human-decisions` pins the replayer.)

## Step 2 — DONE (position-level): the imitation ranker

`scripts/train-ranker.mjs` → `src/play/rankerWeights.json` → `src/play/candidateRanker.ts`,
wired into the MCTS root (`rankCandidates(...)` before the `topK` cut) behind
`SWR_RANKER=1` / `?ranker=1` (sticky). Default OFF until the paired harness has
measured it end-to-end. Turning the ranker on also widens generation to K=4
(`SWR_CAND_K` still overrides), because the ranker was trained on K=4 and only
pays off when the human's move is actually generated.

**Model.** Pairwise logistic (Bradley–Terry style) over `candidateFeatures.ts`:
the heuristic's own score and rank, candidate kind, mission skill/cost/attempt,
target loyalty/subjugation/sabotage/resources/base-distance/force-present,
leader tactic values, adjacent own force, a position summary, and a one-hot
per mission id (the human has strong per-mission preferences the scorer's flat
base values do not capture). ~90 dims; standardised; L2; no dependencies.
Trained on the 672 of 1,119 exact positions where the human's move IS generated
at K=4 — the remaining 447 are unrankable by construction and are the
generator's problem, not the ranker's.

**Result, held-out by game (unseen games), four split seeds:**

| ordering | top-1 | top-3 |
|---|---|---|
| heuristic's own order | 4–6% | 10–13% |
| ranker | **20–32%** | **38–47%** |

No train/test gap on top-1 (27% vs 28% at seed 1). The largest weights read
sensibly: `tgtHasEnemy` (+), `tgtEnemySpace` (+), `tgtOwnSpace` (−), `ldrSpace`
(+), `heurScore` (+), and per-mission preferences (Demolition, Base Defenses,
Hidden Fleet, Behind Enemy Lines up; Sabotage, Contingency Plan down).

**What it does and does not claim.** It is a *ranking* improvement measured at
the position level — the instrument that can actually see it. It is NOT yet a
win-rate claim: the search still decides, and whether exploring human-like
candidates first wins more games is the paired-harness question
(`--realistic --deterministic`, SWR_RANKER on/off). Guarded by
`test-imitation-ranker`: feature layout vs weights, recorded held-out margin
(top-3 +15 points, top-1 ×3 — a bad retrain cannot be committed quietly),
lever off by default, real re-ordering when on, MCTS wiring.

**Retraining.** `node scripts/mine-human-decisions.mjs && node scripts/train-ranker.mjs`
— rerun whenever the archive grows; the weights file records its metrics.

## Step 2b — why a good ranker was flat end-to-end, and what was changed

Three measurements, all from the shipped-pairing traces (Rebel MCTS decisions,
`--realistic` fast-search, 20 games/arm on shared seeds):

1. **Order steered nothing.** `topK` defaults to 12 and only ~6 candidates are
   offered, so every candidate becomes an arm and gets pulled uniformly. With
   the ranker on, the search overrode the ranker's #1 pick in 69% of decisions
   (chose offered-rank #0: 65% off → 31% on) and picked a widened rank-≥4
   candidate 32% of the time. → `SWR_RANKER_PRIOR`: a PUCT term in the
   selection rule so the prior steers pulls; `SWR_RANKER_TOPK`: cut the root to
   the ranker's top-N arms.
2. **Arm means tie.** Gap between the best and second-best arm mean at the
   moment of choice: median **0.000**, p75 0.01 (~4 pulls per arm, near-binary
   rollout outcomes). The final pick was argmax mean, i.e. decided by rollout
   noise — the prior's information was discarded at the moment it mattered
   (search followed the prior's top arm in only 28% of decisions even with the
   PUCT term on). → `SWR_RANKER_FINAL`: λ-blend `mean + λ·P` (λ≈0.05 breaks
   ties without overriding a real +0.2 rollout win) or most-visited arm.
3. **The +30pp mirage.** The first, ungated run re-ordered the Empire's
   candidates with Rebel-trained weights: Rebel 55% → 85% (E→R 7, R→E 1) —
   entirely the Empire being crippled. Gated to the Rebel: 55% → 50%.
   Recorded in the ledger as a trap, and as evidence that candidate ordering
   has real teeth on the Empire — the v2 replayer's data is where that goes.

Arms measured / in flight (all vs the same OFF, seeds 8900): order-only,
PUCT prior w=1, prior + top-3 cut, prior w=4, prior + final λ=0.05, prior +
final by visits; plus a `--deterministic` paired pair (seed 8950). One-table
comparison lives in the session scratchpad script; results go in the ledger.

## Next steps, in order

1. **Ranker end-to-end — first read is FLAT.** 20 games/arm unpaired, Rebel-only
   ranker: Rebel 55% → 50%; activations 4.4 → 5.25/game. (An ungated first run
   showed +30pp, entirely from the Rebel-trained model crippling the Empire's
   ordering — see the ledger row.) Position-level gains are real; whether they
   survive the search is the open question. Next: the `--deterministic` paired
   run (in flight), then test the ranker as a ROLLOUT/leaf policy and at higher
   budget — a 24-pull search may simply re-find the heuristic's pick — and try
   blending ranker score into the arm prior rather than only re-ordering.
2. **v2 replayer** for human-Empire decisions (replay the AI Rebel's opening
   actions) → doubles the dataset and covers the side the MCTS plays.
3. **Plan labels** mined from trajectories (stage-and-strike, consolidate,
   relocate-base first), then the conditional ranker `score(a | pos, plan)`.
4. Round-start plan chooser (learned prior; optional LLM advisor), stateful
   across the round — #539's executor, finally.
5. Evaluate every step position-level first, then with the deterministic
   paired harness, then live.
