# A/B levers — what we tried, what it measured, and against whom

Every AI behaviour change in this project ships behind an `SWR_*` environment
flag so it can be switched off and re-measured. Until this file existed those
flags were the only record, scattered across three source files, and there was
no way to answer "what have we already tried?" without grepping.

This is that record. **Keep it current when you add or re-measure a lever.**

> ## ⚠ Every number in this file measures the HEURISTIC AI, not the one players face
>
> `MCTS_ENABLED` returns **true in a browser** and **false in node**, and
> `PlayTab` registers an MCTS worker policy for the Empire. So the shipped game
> decides the Empire's Command phase with MCTS, while `tournament.mjs` decides
> it with the heuristic unless you pass `--empire-policy mcts`.
>
> MCTS still *consumes* the heuristic — `searchMctsCommand` searches over
> `bestCommandAction(...).slice(0, topK)` — so a lever that changes which
> candidates exist, or their ranking, does carry over. But the final choice is
> the search's, and a lever measured as "neutral" here can still be invisible or
> decisive in a real game.
>
> **This is not a switch anyone forgot to flip.** MCTS costs ~3 s per decision
> in node — roughly 3 minutes a game, ~100× the heuristic — so a 1200-game arm
> is days, not minutes. It is only practical in the browser because it runs in a
> worker against a human's thinking time. Re-basing a lever onto MCTS therefore
> means a deliberate plan: a reduced rollout budget, tens of games rather than
> thousands, and error bars sized accordingly.
>
> Note also that `SWR_MCTS=1` **alone changes nothing in the harness** — it only
> sets `MCTS_ENABLED`. Decisions route through MCTS only when a policy is
> registered, which in the tournament means `--empire-policy mcts`. A run that
> sets the env var and nothing else produces byte-identical results and looks
> like a valid MCTS measurement. It is not.

## Why results expire

A self-play A/B measures a change's value *against the opponent we happen to
have*. That makes results conditional, and three kinds of conditionality have
already bitten us:

1. **Opponent capability.** If the opponent never mounts the attack a change
   defends against, the A/B can only ever see the change's cost. Measured: the
   heuristic Rebel enters the Death Star's system in **3.3%** of games and has
   **never** destroyed a DSUC across 60 games — so the Shield Bunker lever,
   whose whole function is protecting that station, was rejected on a
   measurement that could not have detected its benefit.
2. **Game mode.** `tournament.mjs` ran the **base game** by default until
   2026-08-06. Any expansion-only lever measured before then measured nothing.
   Always pass `--expansion` for RoE content.
3. **Which AI is deciding.** See the banner above: every row here is the
   heuristic Empire; the shipped game uses MCTS. Found 2026-08-11, so no row
   below has been validated against the AI players actually meet.

So a rejection is not permanent. When the AI gets materially stronger, the
contingent rows below are worth re-running.

All three were found the same way — by checking an assumption about the harness
rather than the code under test. When a result surprises you, suspect the
measurement before the change.

## Harness

```bash
node scripts/tournament.mjs --games 1200 --seed 1 --expansion
```

| Flag | Effect |
|---|---|
| `--expansion` / `--roe` | Rise of the Empire content. **Without it you are testing the base game.** |
| `--rebel-policy mcts\|eval` | Give the Rebel a stronger Command brain than the heuristic. |
| `--empire-policy mcts\|eval` | Same for the Empire. **Use `mcts` to measure what players face** — but see the banner: ~3 s/decision, so size the run accordingly. |
| `--games N --seed S` | Sample size and base seed (paired across arms). |
| `--realistic` | **The pairing players actually face**, in one word: MCTS on both sides + `--expansion` + `--fast-search`. Explicit `--rebel-policy` / `--empire-policy` still override it, so `--realistic --empire-policy heuristic` is a one-sided arm. ~40 s/game. Recorded as `policies.realistic: true` in every game log. |
| `--fast-search` | MCTS at budget 24 / horizon 2 instead of 64 / 4. **Validated as a proxy** (below) and ~6× cheaper. The summary and every game log label it, because it is NOT the shipped strength. |

Rough costs: heuristic-vs-heuristic ≈ 20 games/sec; `--rebel-policy eval` ≈
4 s/game; `--rebel-policy mcts` ≈ **115–133 s/game** at full strength (a
300-game arm ≈ 10 h) and **≈ 21 s/game with `--fast-search`** (300 games ≈
1.75 h). Every game log now records `policies: {Rebel, Empire, search}` — pool
directories by that field, never by name.

### The MCTS-Rebel arm (2026-08-16)

The arm every "re-test against a stronger opponent" note in this file was
waiting for. Three things established before trusting it:

- **Fast-search is a faithful proxy.** 12 games, paired seeds, full (64/4) vs
  fast (24/2): identical 12/12 outcomes, avg rounds 9.4 vs 9.2, end reputation
  9.4 vs 9.2, at 133 s vs 21 s per game. Nothing measurable is lost.
- **It is a real stick, not a broken one.** First 28 games were 28 Rebel wins,
  which would have made it useless (a 100% opponent cannot register anything
  the Empire does). At n=60 it settles at **~86% Rebel** with the Empire still
  winning by base-capture — so the needle moves. Compare the heuristic Rebel's
  ~65% on comparable seeds.
- **It is stronger in the way the notes predicted.** It scores **4.33 objectives
  per game vs the heuristic's 2.65** and wins on reputation-time — the exact
  "tempo gap" (AI wins ~10 rounds vs an expert's ~6) written into randomAI.ts.
  So a lever whose value is *denying the Rebel objectives* now has an opponent
  that actually pursues them.

What it still is NOT: a human. It doesn't play Heart of the Empire twice a
game the way jocke01 does, and it inherits the heuristic's move generator
(MCTS searches over `bestCommandAction`'s output), so a mission the heuristic
suppresses is invisible to the search too. Fixture evidence still outranks it
for behaviours the Rebel AI never exhibits.

### The MCTS-Empire arm (2026-08-17)

`--empire-policy mcts`, same `--fast-search` and per-game `policies` record.
It is a different animal from the Rebel arm in two ways that matter:

- **It IS the shipped Empire.** `MCTS_ENABLED` is true in the browser, so every
  Empire-side player report in the queue was generated against THIS opponent,
  not the heuristic. That means every Empire lever measured heuristic-vs-
  heuristic in this ledger was measuring an AI nobody plays. The
  `SWR_DS_CAUTION` and passivity-cluster work in particular should be re-read
  under this arm before anything is concluded.
- **It determinizes.** The Empire samples hidden-base worlds (`worlds: 8` in
  its traces), which the Rebel search does not need to. So its cost is
  `budget × horizon × dets`; measured **~92 s/game full, ~19 s/game
  fast-search** — cheaper than the Rebel arm at both profiles because Empire
  Command decisions are fewer per game.

Validated 2026-08-17:

- **Fast-search is a slightly WEAKER proxy here, not a faithful one.** 12
  paired seeds, full (64/4/8) vs fast (24/2/8): Empire **11/12 vs 9/12**, two
  seeds flip E→R under fast, avg rounds 8.2 vs 8.1, at 127 s vs 21 s. That is
  the determinization budget biting — with `horizon 2` the search sees fewer
  base-hunt payoffs. So unlike the Rebel arm, treat fast-search Empire numbers
  as a **lower bound** on the shipped Empire's strength, and use full search
  for any verdict that hinges on the Empire being strong enough.
- **The shipped Empire is far stronger than the harness default implied.** At
  n=60 (fast-search, so if anything understated): **Empire 73.3% (SE 5.7)**,
  44 base-captures, base revealed in 80% of games — versus **~35%** for the
  heuristic Empire on comparable seeds. The heuristic-vs-heuristic default has
  been measuring an Empire roughly *half* as strong as the one players face.

Consequences worth stating plainly:
1. **The passivity cluster is about a STRONG AI's occasional bad decisions**,
   not a weak AI's general drift. That reframes it as a search-quality problem
   (the `mctsAI.ts` pass-margin / keep-playing guards), which is exactly where
   the #630/#580 fixture work already lives — the fixture approach was right.
2. **Every heuristic-vs-heuristic Empire harm check this week understated the
   Empire.** The fixture evidence for `SWR_DEFEND_CORUSCANT`, `SWR_CAPTURE_
   ASSIGN`, `SWR_TIEBREAK` still stands (fixtures test the scorer MCTS searches
   over), but their harm checks should be re-run under this arm before anyone
   leans on the win-rate numbers.
3. **The harness default should probably be MCTS-vs-MCTS**, since that is the
   only pairing where both sides resemble what a player faces. Cost is the
   obstacle: ~40 s/game fast, ~4 min/game full. Standard error on a win-rate difference is
roughly `2.0pp` at n=1200 and `3.5pp` at n=400 — size the run to the effect you
care about.

**Symmetric changes cannot be measured symmetrically.** If a lever affects both
sides, self-play nets it out and the result reads as noise no matter how strong
the change is. `SWR_COMBAT_CARDS` accepts `empire` / `rebel` for exactly this
reason — enable one side and play it against the other.

## Robustness classes

- **Mechanical** — the AI was doing something that accomplishes nothing *by the
  rules*. Value does not depend on the opponent. These do not need re-testing.
- **Contingent** — defensive, denial-based, or tempo-based. Value depends on
  what the opponent does. **Re-test these when the AI improves.**

## The ledger

Measurements are Empire win rate unless noted, from `tournament.mjs`.

| Lever | Default | Class | Last measured | Result |
|---|---|---|---|---|
| `SWR_PASS_FORFEIT` | **ON (0.5)** | mechanical (evaluator bug) + contingent | 2026-08-21, 120 RoE `--realistic` (60/arm, paired seeds) | **Charges the leaf evaluator for a forfeited Command round.** `passedThisCommand` appeared NOWHERE in either evaluator, so a pooled leader scored the same whether or not its owner had just given up the ability to use it — passing was FREE. Charges leaders the pass STRANDS (pooled, or on a face-down mission that can no longer be revealed); on-board leaders are not charged. Tempo cost, not a loss, so it is a fraction of leader worth; symmetric. **Fixture (decisive):** #600's board, shipped Rebel (eval depth-2), **30/30 passes → 0/30**, with reveal@naboo at 37 vs pass at 0.5. Weight swept on that board: 0/0.15/0.25 → still 30/30; 0.35/0.5/0.75/1.0 → 0/30; 0.5 chosen mid-range. **Win rate: Rebel 33.3 → 48.3 (+15.0pp, CI [−2.4,+32.4]) — NOT significant at n=60**, but large, positive, and mechanically coherent (avg rounds 8.0→8.7, base-captured 40→31, reputation-time 20→29: the side that stops forfeiting gets more done and games run longer). Empire premature passes (a ≥20 play available) 2→1, (≥35) 0→0 — no harm. **Measurement gap to know about:** Rebel premature passes are UNCOUNTABLE in the shipped pairing — `evalCommandStepDeep` emits no `ai-decision` traces (only mctsAI and randomAI do), so the Rebel column reads 0/0 in both arms and means nothing. The fixture is the only Rebel-side evidence, and it is decisive. Confirmatory n=150/arm queued. |
| `SWR_HOLD_BASE` | ON | contingent — **self-play cannot judge it** | 2026-08-16, 600 RoE (300/arm, paired seeds) | Revealed-base hold-or-flee (#638/#508). Old rule was an unconditional flee on Rapid Mobilization when revealed. New: weigh Imperial force that can REACH the base next round (on it + adjacent, dice+health) vs the garrison; hold when defence ≥ 1.25× threat or nothing can reach; a Death Star within 2 jumps → flee regardless. **Rebel win rate 65.0 → 64.3 (−0.7pp, CI [−8.3,+7.0]) — no effect.** The rule fires (94 declines/300 games, relocations 132→114) and post-reveal survival of held bases ticks 39%→44%, inside noise. This is the ledger's own long-standing warning made concrete: hold-defender self-play already maxes the Empire, so 'can I hold' against a competent capturer is ~a coin flip either way. What self-play CANNOT tell us is whether it beats a HUMAN Empire, which is the reporters' frame. Shipped ON because it is RAW-faithful, removes the LEGIBLE blunder (fleeing a revealed base nothing can reach), and costs nothing measurable. **RE-TESTED vs the MCTS-Rebel arm** (2026-08-16, 60/arm, fast-search, paired seeds): Rebel 86.7 → 85.0 (−1.7pp, CI [−14.1,+10.8]) — **still noise**; per-seed 51 R→R, 8 E→E, 1 R→E. The rule fires (10 holds/60) against an opponent that DOES pursue objectives, and still moves nothing. Two opponents now agree: this is a correctness fix, not a strength lever. Recorded as VALIDATED-NEUTRAL, which is the honest ceiling for it. **Lesson paid for in full:** a first cut resolved the hold via the `move-units` branch, which the card forbids once revealed ("IF the Rebel base is not revealed…"); the engine rejected it and **79/300 games hung** on the choice. The Rebel win rate fell 62→48 and I nearly read the per-reveal survival numbers (held 70%!) as a win before noticing BOTH sides' win rates had fallen — the tell for a third outcome. Always check `stuck` before reading any other column. The legal hold is RR p.11: draw the probes, then DECLINE at the base pick. |
| `SWR_CAPTURE_ASSIGN` | ON | mechanical (structural bug) | 2026-08-15, 600 RoE (300/arm, paired seeds) | Capture Rebel Operative **assigned 0.21 → 3.17 per game, revealed 0.19 → 2.89, median first attempt turn 6 → 5, leaders captured (all causes) 0.71 → 2.38/game**. Win rate 37.0 → 36.0 (inside noise, SE ~3.9pp) — **no harm, no measurable benefit**. Root cause is structural, not tuning: assignment only happened if a Rebel leader was ALREADY in a system with an Imperial unit, and **513 of 513 measured rounds had ZERO Rebel leaders on the board when Assignment began** (they reach the board only when they reveal their own missions during Command). The gate asked its question at the one moment each round the answer cannot be yes. The exception already existed for `detained` and `collect-bounty` with a comment describing this exact problem; capture-rebel-operative was never added to it. Stricter than its siblings by design: they target a leader "in any system", this one needs one "in a system that contains an Imperial unit", so it also requires the Empire to hold ground somewhere. **Open question the harness cannot answer:** whether 2.89 attempts/game is the RIGHT amount. Base value 11 sits under gather-intel 15 and R&D 13, and self-play cannot judge the worth of a capture against a Rebel AI that does not scramble to rescue. Reported by jocke01, who argues it should start turn 2-3. |
| `SWR_DEFEND_CORUSCANT` | ON | **mechanical — self-play CANNOT measure it** | 2026-08-15, fixture + 300-game harm check | Empire reaction to a Rebel force massing next to Coruscant. Fixture, before → after: 6 Rebel units one jump from an EMPTY capital scored **2 and ranked LAST of 4** → 31; with a token garrison **10, last → 38, FIRST**; Rebels already on the capital 18 (3rd) → 35 (1st). A quiet capital is byte-identical to lever-off, and a lone scout still isn't offered — no false positives. **Why no win-rate arm:** across 300 RoE games the AI Rebel played Heart of the Empire 8 times total (0.027/game) and Threaten the Core 11; a human plays the first 2+ times in ONE game. The harness opponent never mounts the attack, so an A/B measures the absence of the threat, not the quality of the defence — the self-play arm is a HARM check only. Root cause: the old term keyed on `hasEnemyUnits && !hasOwnUnits`, i.e. it woke up only once Rebels stood on the capital AND the garrison was already dead — the exact instant Heart of the Empire becomes scoreable — and docked Coruscant 3 for being 'quiet' until then. Neither objective was modelled: Threaten the Core counts units "in AND/OR ADJACENT TO" Coruscant, and Heart of the Empire RETURNS TO HAND, paying 2 rep every Refresh until the Empire puts a unit back. Reported by jocke01. |
| `SWR_TIEBREAK` | ON | **mechanical — win rate cannot measure it** | 2026-08-15, 600 RoE (300/arm, paired seeds) | **Empire mission targets on the 6 alphabetically-first systems: 54.8% → 20.8%** (an unbiased share for 6 of 32 is 18.8%). Win rate 38.7 → 33.7 (−5.0pp, SE 3.9, CI [−12.7,+2.7]) — **not significant, and not interpretable**: the tiebreak applies to BOTH sides, so symmetric self-play cannot detect it (same trap as `SWR_COMBAT_CARDS`). An earlier n=40 run gave +2.5pp — the sign flips between runs, which is what noise looks like. Root cause: systems.json is stored alphabetically (alderaan = index 0), candidate lists come from `Object.keys(G.map.systems)`, and both `if (s > best)` and the STABLE `.sort()` keep the first maximum. Playtester jocke01 diagnosed it from the outside: "it often targets alderaan with missions. I think it's because it's first in alphabetical order." Gainers are the outer systems he said the Empire never reached (sullust, ryloth, utapau, ord-mantell, saleucami, rodia, each ~0.1–3% → 3–7%). Tiebreak is a hash of the candidate salted with `G.rng.state` (READ, never advanced), NOT Math.random: the app has undo, and a nondeterministic AI would answer an undone position differently and would make ~39 of the 67 AI-driving tests coin-flips. |
| `SWR_RESOURCE_SHAPE` | ON | contingent | 2026-08-06, 1200 RoE | **+2.8pp** (38.0→40.8), base found 61.4→67.7%. Weigh subjugation targets by icon shape, not count (#694). |
| `SWR_SUBJ_GROUND` | ON | mechanical | 2026-08-06, 1200 RoE | Neutral (40.8 vs 40.7). Ground-less "subjugation" moves 30/595 → 9/595 (#696). |
| `SWR_REAL_REINFORCE` | ON | mechanical | 2026-08-06, 1200 RoE | **+1.6pp**. Transport/garrison-aware reinforcement estimate; hopeless lone-ship attacks 5 → 0 (#653). |
| `SWR_THEATER_ODDS` | ON | mechanical + contingent | 2026-08-07, 1200 RoE | **Neutral (40.7 → 40.2, inside noise).** Don't score a ground rout the rules will not roll: the "can't win the ground fight" penalty now needs the Empire to actually have ground there, since combat.ts gates each theatre on `bothSidesHaveTheater`. Also stops the "already Imperial, gains nothing" and "don't waste activations on Coruscant" penalties firing on a system the REBEL is holding. Empire activations onto a Rebel-held Coruscant **65 → 92** (59 → 87 of 1200 games). Base-found 67.2→66.8, subjugations 13.9→13.8, passes 7.8→7.8, stuck 0 — no regression signal. Planner smoke: same 7 PASS / 1 FAIL in both arms. **Benefit is NOT measurable here** — see below (#697). |
| `SWR_ASSIGN_OPP` | ON | contingent | 2026-08-06, 1200 RoE | **+5.0pp** (33.0→38.0). Largest single gain. Base game showed *nothing* (29.9 vs 29.5) — mode mattered. |
| `SWR_COMBAT_CARDS` | ON | contingent | 2026-08-06, 1200 RoE | **+1.7pp**. Play Start-of-Combat action cards. Symmetric — needs the per-side form to measure. |
| `SWR_DSUC_GARRISON` | **OFF** | contingent | 2026-08-06, 1200 RoE + 400 vs strong | **REJECTED.** −5.4pp vs heuristic Rebel (38.0→32.6), −2.3pp vs eval-depth2 Rebel (29.8→27.5). Base found 61.4→55.3%. Penalty halves against the stronger opponent and is inside noise at n=400; cost is opponent-independent, so the verdict is fairly robust. |
| `SWR_BUNKERS` | **OFF (was ON 2 days)** | contingent — **REJECTED again on the strong-opponent re-test** | 2026-08-16, 120 RoE vs MCTS-Rebel (60/arm, fast-search, paired seeds) | The 2026-08-15 acceptance rested on a self-play +2.0pp sign-flip that was itself inside noise, and its own row asked for this re-test. Against a Rebel that DOES attack the station (18 assaults on the DS system, 16 successful Death Star Plans rolls across both arms): bunkers deployed **34 → 81**, reaching the DS system **1 → 7** (still ~8%), **Death Star Plans BLOCKED: 0 → 0** in 120 games, Death Stars destroyed 6 → 10, Empire win 21.7 → 16.7 (−5.0pp, CI [−19.1,+9.1], noise). Per-seed 44 R→R, 7 E→E, 6 E→R, 3 R→E. The mechanism does not engage: bunkers only chase a station present at deploy time, and the Plans hits land where no bunker ever arrived — so the lever spends 2.4× the build slots and blocks nothing, against an opponent that punishes tempo. **Lesson:** the +2.0pp self-play flip looked like the predicted sign change and I shipped on it; a sign flip inside noise is still noise, and the arm that could actually see the mechanism was the one that hadn't been run. Placement code stays wired (`SWR_BUNKERS=1`) and test-shield-bunker-guards-death-star sets it, in case a smarter placement rule (chase the Death Star as it MOVES, not just at deploy) is ever tried. History: 2026-08-06 rejected −2.5pp vs weak Rebel; 2026-08-15 accepted +2.0pp self-play; 2026-08-16 rejected vs MCTS-Rebel. |
| `SWR_OPPOSE_IDLE` | ON | mechanical | 2026-08-10, 1200 RoE | **Neutral (40.2 → 40.0, two games).** A leader with NO tactic values cannot activate a system by RAW, so the "a leader spent opposing is an activation foregone" skip charges him a price of zero. Exempts Boba Fett / Jabba / Greejatus from it (#704). Empire passes while holding an idle no-tactic leader 27/477 (5.7%) → 3/475 (0.6%); such leaders opposing 2.3% → 7.6%. Passes 7.8 → 7.8 and activations 24.2 → 24.2, so it does not disturb the skip's original purpose. |
| `SWR_DS_CAUTION` | **OFF** | contingent | 2026-08-09, 1200 RoE + 60-game mechanism | **WORKS, BLOCKED.** Stops the Death Star being swept along into reach of Rebel ships (#701). Station moves ending in/beside Rebel ships 69/204 (33.8%) → 5/168 (3.0%), games affected 61.7% → 8.3%, stations lost 8.3% → 6.7%, still moves (168 vs 204). Win rate 40.2% → 40.4% — noise. **Not shipped:** holding it back shrinks what an activation delivers, and on the #639 duplicate-arm fixture that makes the Empire pass 8% of the time (0% without), reproducible. **The obvious next step was tried and does NOT work:** the scorer and executor were unified onto one planner (2026-08-10) so the score reflects exactly what moves. That made this fixture WORSE, 8% → 17%, which makes sense in hindsight — an honest scorer values a weakened activation lower, so passing wins more often. The blocker is not the divergence; it is that when every available move gets worse the AI prefers passing to taking the best remaining one. Look at the pass margin (`SWR_MCTS_PASS_MARGIN` / `SWR_EVAL_PASS_MARGIN`), not the scorer. Self-play also under-values the benefit: the station only dies to a Death Star Plans attempt, which the heuristic Rebel rarely builds on purpose. |
| `SWR_NOOP_GUARD` | ON | mechanical | pre-2026-08 (see code) | Sinks activations that provably cannot move or fight (#647). |
| `SWR_SELF_MOVER` | ON | mechanical | pre-2026-08 (see code) | X/Y-Wings move without a carrier; previously 80% of Rebel activations moved nothing. |
| `SWR_ACTIVATE_DIVERSITY` | ON | contingent | pre-2026-08 (see code) | Distinct activation targets per leader (#599). |
| `SWR_ASSIGN_GATE` | ON | contingent | pre-2026-08 (see code) | Don't assign a leader to a mission the Command phase would refuse to reveal. |
| `SWR_EMPIRE_PLANNER` | **OFF** | contingent | pre-2026-08 (see code) | Strike-fleet plan layer (#539). |
| `SWR_HUNT_OCCUPY` | see code | contingent | pre-2026-08 (see code) | Occupy-to-clear base candidates. |

### `SWR_THEATER_ODDS` — why the number above proves less than it looks

This is the "opponent capability" trap from the top of this file, and it is worth
spelling out so the neutral result is not later misread as "measured, worthless."

The lever's *point* is denial: a Rebel force on Coruscant with no Imperial unit
present scores Heart Of The Empire, which pays **2 reputation at every Refresh
and returns to hand instead of being spent**. The Empire only has to be there to
stop it. For self-play to price that, the heuristic Rebel would have to actually
pursue the occupation — and it barely does: it moves a unit to Coruscant in
**201 of 1200 games (16.8%)**, incidentally rather than as a plan. So in five
games out of six the lever cannot fire at all, and the A/B sees its cost with
almost none of its benefit.

What the run *does* establish is that the cost is ≈ zero and the mechanism is
live (Coruscant contests up 42%). The mechanical half — not docking 30 points
for a ground battle that `bothSidesHaveTheater` will never start — is
opponent-independent and needs no re-test. The Coruscant denial bonus is
contingent and **currently unvalidated in either direction**; re-run it when the
Rebel AI is good enough to camp the capital on purpose.

Known limit, measured: on the reporter's actual board this moves the heuristic
prior for Coruscant from **−11 (filtered out entirely, below the `ts > 0`
cutoff) to 45 (second of eight)**, and the reported bad move — shuffling the
fleet to an empty neutral — drops from 13% to **0%** of 30 MCTS searches. But
MCTS still does not *pick* Coruscant: it prefers a base-hunt activation. The
prior can only offer the move; making the search value denying a repeating
objective is a separate piece of work in `boardEval`/rollouts.

Rows marked "pre-2026-08 (see code)" predate this ledger; their rationale lives
in the doc comment at the flag definition, but the numbers were not recorded in
a form worth copying here. **Do not restate them as measured facts** — re-run
them if you need the figure.

Tuning knobs rather than on/off experiments (`SWR_AGGRO`,
`SWR_REBEL_BASE_KEEP`, `SWR_BASE_PLACEMENT`, the `SWR_MCTS_*` family,
`SWR_LEARNED_*`, `SWR_EVAL_*`) are deliberately not listed as levers; see their
definitions.

Deploy/ops variables (`SWR_ADMIN_TOKEN`, `SWR_BASE_URL`, `SWR_BUGREPORT_*`) are
unrelated to A/B and documented in `docs/deploy.md`.

## Recording a new lever

1. Ship the behaviour behind `SWR_<NAME>`, defaulting to the **current**
   behaviour so an unset environment is unchanged.
2. Measure both arms at a sample size that can see the effect, in the mode the
   change applies to (`--expansion` for RoE content). **Heuristic-vs-heuristic
   is the cheap smoke run, not the verdict.** Since 2026-08-17 the harness
   default plays an Empire about half as strong as the shipped one, so:
   - a lever may be recorded as **validated** only from a `--realistic` run
     (both sides MCTS — the pairing players face). Note the caveat that
     fast-search *understates* the Empire; if the verdict hinges on Empire
     strength, run the Empire arm at full search.
   - a heuristic-only result is recorded as **smoke** and says so.
   - a fixture (a captured board with the decision asserted directly) still
     outranks both for behaviours the AI opponent never exhibits — see
     `SWR_DEFEND_CORUSCANT` for the worked example.
3. Add a row here with the date, sample, mode, **which policies were on each
   side**, and result — including rejections. A rejection you didn't write
   down gets re-implemented later. A verdict whose opponent you didn't write
   down gets trusted later against a different opponent (see `SWR_BUNKERS`,
   accepted on self-play noise and rejected two days later).
4. State the robustness class, and if the result is contingent, say what about
   the opponent it depends on.
