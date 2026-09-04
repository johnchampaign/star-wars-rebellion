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

Results (all vs the same OFF at Rebel 55%, seeds 8900, 20/arm, 0 stuck):

| wiring | Rebel | Δpp | E→R / R→E | followed prior |
|---|---|---|---|---|
| order only (Rebel) | 50% | −5 | 3/4 | — |
| PUCT prior w=1 | 55% | 0 | 3/3 | 28% |
| PUCT prior w=4 | 55% | 0 | 4/4 | 30% |
| prior + top-3 arm cut | 30% | **−25** | 2/7 | 35% |
| prior + final λ=0.05 | 40% | −15 | 2/5 | 43% |
| **prior + final by visits** | **70%** | **+15** | 5/2 | 48% |
| ranker as rollout policy | 55% | 0 | 5/5 | 31% |
| deterministic PAIRED, prior w=1 (seed 8950) | 50% vs 50% | 0 | 5/5 | — |
| **deterministic PAIRED, final by visits (seed 8950)** | 50% vs 55% | +5 | 2/1 (17 identical) | 48% |

Verdict: the position-level gain is real; through the shipped search it is flat
in EVERY wiring. The "final by visits" +15 did not survive its paired
confirmation (3 discordant pairs in 20, McNemar p = 1.0) — it was noise, as
the measured noise floor predicted. A full-budget pair (64 pulls, what the
browser runs) came back with the batch's largest signal: **Rebel 35% → 55%**
(E→R 7 / R→E 3, McNemar p=0.34, follow-rate 61% vs 28–48% at fast-search).
**Confirmed on fresh seeds: 20% → 55% (p=0.04); a third pair 45% → 50%. Pooled
n=60/arm: 33% → 53%, +20pp, CI [+3,+37], McNemar p=0.036.** Honest size:
~+15–20pp (the two post-selection pairs average +20). The first replicated end-to-end win in
this plan, and it exists only at the browser's real budget — which resolves the
batch: the earlier flat results were the fast-search harness, not the ranker.
**Shipped ON by default 2026-09-03 (John's call)** — ranker + final pick by
most-visited arm is now the AI Rebel everyone faces; `?ranker=0` /
`?rankerfinal=0` opt out (sticky). The archive records the flags per game, so
the live human-vs-AI record is the ongoing instrument. Two related decisions
the same day: the harness gained a `--verdict` tier (full search budget) after
fast-search hid this effect, and the in-game log became turn-filterable and
pageable (#740) so players can verify earlier battles themselves. Two honest readings: the 24-pull
fast-search budget is the bottleneck (the browser searches 64 pulls under 8s —
test the visits build at full budget), and/or the Rebel has little to gain from
ordering while the Empire demonstrably does (the ungated mirage) — so the v2
replayer's Empire data is the higher-leverage next step.

## Step 4 — the Assignment phase, from the same data (2026-09-03)

The ranker never touched Assignment (the override is consulted only in Command).
Two long-open "not a real problem" reports (#555, #718) both said the AI Rebel
plays Rapid Mobilization every turn. `mine-human-decisions --stage assignment`
now emits the exact state at the moment the human begins assigning plus their
final assignment set (871 rounds from 150 games; 335 exact human-Rebel), and
`eval-assignment-agreement.mjs` runs the heuristic's planner on those same
positions:

| on the same positions | human | heuristic before | after |
|---|---|---|---|
| Rapid Mobilization assigned | 15% | **66%** | **17%** |
| … with the base hidden | — | 65% | 15% |
| Sabotage | 83% | 71% | 73% |
| Hidden Fleet | 2% | 11% | 6% |
| mission-set agreement (Jaccard) | — | 0.52 | 0.58 |

Cause: the RM discipline gate's "massing" branch counted Empire ground within
two hops, true in 67% of hidden-base positions. Humans' RM rate barely tracks
that count; a hidden base is treated as safe unless the threat is one hop away.
Fixed (`SWR_RM_GATE`), base values calibrated (`SWR_ASSIGN_CALIB`).

Two more claims from those reports, measured: humans open turn 1 with an
activation (Rodia/Saleucami 16% each) or Build Alliance @ Utapau (16%); the old
AI Rebel opened Build Alliance @ Nal Hutta 46% — a single scripted opener
(#718 part 2 confirmed; now a Command-phase question for the ranker+MCTS
Rebel). Attacks into Imperial-held systems: humans make MORE of them (797 vs
305) but the AI's are less productive (59% vs 48% yield nothing that round).
The Empire side's assignment agreement is low (Jaccard 0.26) — an Assignment
ranker trained on the human Empire's assignments is the natural next build.

## Step 5 — what the shipped policies actually do on real boards (2026-09-04)

Two instruments, both position-level, both run against the SHIPPED policies
(MCTS budget 64 + ranker) on the exact-state dataset. They answer two long-open
reports with measurements rather than another round of triage.

### The Rebel opener — #718 part 2, now measurable

`scripts/measure-rebel-opener.mjs` replays the 110 exact turn-1 human-Rebel
positions and asks each policy what IT would open with from that same board.

| on the same 110 boards | top opener | distinct openers | opens with a move | plays the human's move |
|---|---|---|---|---|
| winning human | 23% Build Alliance @ Utapau | 32 | 49% | — |
| plain heuristic | 18% Sabotage @ Mygeeto | 14 | 0% | 3% |
| old shipped Rebel (`eval` depth-2) | **56% Build Alliance @ Nal Hutta** | 16 | 6% | 11% |
| **shipped (mcts + ranker)** | **14% activate @ Rodia** | **40** | 62% | **30%** |

The "single scripted opener" the reporter described is gone — Nal Hutta falls
56% → 7%, the top opener is down to 14%, and the reveal/activation mix moves
from 6% activations to 62% (human: 49%). **Utapau is still under-weighted**:
humans target it turn 1 in 26% of these openings, the shipped Rebel in 12%
(the old one 19%, the heuristic 5%). So the structural half of #718 part 2 is
fixed and the preference half is not.

**Caveat that must travel with the 30%:** these positions are inside the
ranker's training set, so agreement here is IN-SAMPLE and optimistic — the
held-out-by-game figure for the shipped weights is 27% top-1. The distribution
claims (concentration, distinct openers, activation share) are far less
sensitive to that than the agreement figure is.

### The Empire post-reveal cluster — evidence against #539's current scope

The #539 cluster (#538/#690/#708/#722) is filed as a CHOICE failure: "the base
is revealed and the Empire walks its heavy force the wrong way / activates the
base space to do nothing." Measured on the 51 exact post-reveal human-Empire
boards, that symptom does not reproduce as a single-decision failure.

| hops from the revealed base to the chosen target | n | mean | at base | within 1 | ≥3 away |
|---|---|---|---|---|---|
| winning human | 51 | 1.75 | 22 | 30 | **20** |
| shipped Empire | 50 | **0.80** | 28 | 41 | **4** |

The AI aims at the base *more* single-mindedly than a winning human. Applying
each chosen action and reading the engine's own `unitsMoved`: **mean 11.65
units per activation, 1 of 46 moved ≤1 unit.** Exact agreement 20% (heuristic
18%).

`scripts/measure-reveal-force.mjs` then compares the reveal-moment POSITION —
45 AI-built boards (reveal snapshots from human-Rebel logs, where the Empire is
the AI) against the same 51 human-built ones. Both put **17%** of Empire mobile
ground within one hop of the base (5.11 vs 5.92 units, medians 4 vs 5), and the
AI reaches its reveal a round earlier (6.0 vs 7.1).

**Limits, which are real:** opponent asymmetry (the human-built boards come
from games against the AI Rebel, the AI-built ones from games against a human
Rebel — not equally hard positions); selection on won games; and single-decision
scope, which cannot see the following rounds where a stateful plan would act.

**Reading.** #539 is scoped to fix post-reveal destination choice and pre-reveal
staging. On real boards the first now measures better than a winning human's and
the second indistinguishable from one. The unmeasured thing is multi-round
FOLLOW-THROUGH — whether a massed force arrives and assaults or is peeled apart
again over the next two rounds. If it does arrive and the Empire still loses,
#539's premise moves from logistics to assault strength, which is different work.

**Harness gap found in passing:** `scripts/verify-reveal-forward.mjs` installs no
Command policy override, so it drives the PLAIN HEURISTIC, not the shipped MCTS
Empire. The "2.33 ground delivered" baseline from 2026-08-27 and the retrograde-
guard verdict built on it therefore describe a policy no player faces. Worth
closing regardless of what happens to #539.

## Next steps, in order

1. **Ranker end-to-end — first read is FLAT.** 20 games/arm unpaired, Rebel-only
   ranker: Rebel 55% → 50%; activations 4.4 → 5.25/game. (An ungated first run
   showed +30pp, entirely from the Rebel-trained model crippling the Empire's
   ordering — see the ledger row.) Position-level gains are real; whether they
   survive the search is the open question. Next: the `--deterministic` paired
   run (in flight), then test the ranker as a ROLLOUT/leaf policy and at higher
   budget — a 24-pull search may simply re-find the heuristic's pick — and try
   blending ranker score into the arm prior rather than only re-ordering.
2. **v2 replayer — DONE (2026-09-02).** The Command stage replays the AI Rebel's
   opening actions (reveal → implicit-decline/oppose → mission effects; activations
   rebuilt from their move-unit events) until the human Empire is to act. Full
   archive: 2,254 of 2,723 rounds reach an exact/approx first-decision state;
   **2,251 samples — Rebel 1,146 exact / Empire 821 exact**; replayed mission dice
   match the recorded dice **33/33**. Coverage (instrument): K=1 Rebel 31% / Empire
   27% in-candidates; K=4 Rebel 60% / Empire 64%.
   **Finding: a joint model does not help the Empire.** Held-out by game — Rebel:
   heuristic top-1 5.6% → ranker 29.2%; **Empire: 14.9% → 11.9%** (top-3 31.7% →
   32.7%). The Empire's heuristic already ranks its own candidates far better,
   and its winning moves are the plan-dependent kind (stage-and-strike) a
   positional ranker cannot see — which is the plan-label step's job. Shipped
   weights are therefore Rebel-only (`--sides Rebel`: top-1 27.1%, top-3 43.1%,
   n=144); the Empire data stays in the dataset for step 3.
2b. **(was: v2 replayer)** for human-Empire decisions (replay the AI Rebel's opening
   actions) → doubles the dataset and covers the side the MCTS plays.
3. **Plan labels** — design input measured 2026-09-02 on the 344 human-Empire
   games won by base capture (of 362 finished; 8 base-destroyed, 10 rep-time):
   nearest Imperial GROUND to the eventual base, by rounds before capture —
   share within 1 hop: T−8 10%, T−6 35%, T−4 52%, T−2 64%, T−1 78%, T−0 99%;
   median hops 2 until T−4, then 1. The stage-and-strike shape is visible and
   monotone, so round labels are derivable from outcomes: `strike` (T−1..T−0,
   force adjacent), `stage` (T−4..T−2, closing on a candidate), `search`
   (earlier). This is exactly the context the Empire ranker lacked (the joint
   model went 14.9% → 11.9% top-1 on Empire positions) — the conditional
   ranker `score(a | position, plan)` is the next build.
   Plan labels mined from trajectories (stage-and-strike, consolidate,
   relocate-base first), then the conditional ranker `score(a | pos, plan)`.
   **Measured the same day** (`scripts/label-plans.mjs` labels all 2,723 rounds
   from outcomes; `train-ranker.mjs --plans oracle [--per-plan]`): conditioning
   on the ORACLE plan — the ceiling for any runtime plan chooser — does NOT
   improve ranking. Empire held-out (n=101): heuristic 14.9% / 31.7%, single
   ranker 15.8% / 35.6%, per-plan rankers 16.8% / 35.6%. Rebel (n=137): single
   26.3% / 42.3%, per-plan 27.7% / 40.9%. Structural reason: a plan one-hot is
   constant across a position's candidates and cancels in every pairwise
   difference (only interactions carry it — hence per-plan models), and those
   are data-starved at ~110–140 Empire positions per plan. Deeper reading: the
   plan signal lives in move ORDERS and multi-round consistency, not in which of
   ~6 root candidates is chosen — the root candidate is too coarse for the
   Empire's game. That points back at #539 (a stateful plan shaping move
   orders), not a better root prior.
4. Round-start plan chooser (learned prior; optional LLM advisor), stateful
   across the round — #539's executor, finally.
5. Evaluate every step position-level first, then with the deterministic
   paired harness, then live.
