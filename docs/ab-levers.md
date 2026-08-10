# A/B levers — what we tried, what it measured, and against whom

Every AI behaviour change in this project ships behind an `SWR_*` environment
flag so it can be switched off and re-measured. Until this file existed those
flags were the only record, scattered across three source files, and there was
no way to answer "what have we already tried?" without grepping.

This is that record. **Keep it current when you add or re-measure a lever.**

## Why results expire

A self-play A/B measures a change's value *against the opponent we happen to
have*. That makes results conditional, and two kinds of conditionality have
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

So a rejection is not permanent. When the AI gets materially stronger, the
contingent rows below are worth re-running.

## Harness

```bash
node scripts/tournament.mjs --games 1200 --seed 1 --expansion
```

| Flag | Effect |
|---|---|
| `--expansion` / `--roe` | Rise of the Empire content. **Without it you are testing the base game.** |
| `--rebel-policy mcts\|eval` | Give the Rebel a stronger Command brain than the heuristic. |
| `--empire-policy mcts\|eval` | Same for the Empire. |
| `--games N --seed S` | Sample size and base seed (paired across arms). |

Rough costs: heuristic-vs-heuristic ≈ 20 games/sec; `--rebel-policy eval` ≈
4 s/game, so budget accordingly. Standard error on a win-rate difference is
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
| `SWR_RESOURCE_SHAPE` | ON | contingent | 2026-08-06, 1200 RoE | **+2.8pp** (38.0→40.8), base found 61.4→67.7%. Weigh subjugation targets by icon shape, not count (#694). |
| `SWR_SUBJ_GROUND` | ON | mechanical | 2026-08-06, 1200 RoE | Neutral (40.8 vs 40.7). Ground-less "subjugation" moves 30/595 → 9/595 (#696). |
| `SWR_REAL_REINFORCE` | ON | mechanical | 2026-08-06, 1200 RoE | **+1.6pp**. Transport/garrison-aware reinforcement estimate; hopeless lone-ship attacks 5 → 0 (#653). |
| `SWR_THEATER_ODDS` | ON | mechanical + contingent | 2026-08-07, 1200 RoE | **Neutral (40.7 → 40.2, inside noise).** Don't score a ground rout the rules will not roll: the "can't win the ground fight" penalty now needs the Empire to actually have ground there, since combat.ts gates each theatre on `bothSidesHaveTheater`. Also stops the "already Imperial, gains nothing" and "don't waste activations on Coruscant" penalties firing on a system the REBEL is holding. Empire activations onto a Rebel-held Coruscant **65 → 92** (59 → 87 of 1200 games). Base-found 67.2→66.8, subjugations 13.9→13.8, passes 7.8→7.8, stuck 0 — no regression signal. Planner smoke: same 7 PASS / 1 FAIL in both arms. **Benefit is NOT measurable here** — see below (#697). |
| `SWR_ASSIGN_OPP` | ON | contingent | 2026-08-06, 1200 RoE | **+5.0pp** (33.0→38.0). Largest single gain. Base game showed *nothing* (29.9 vs 29.5) — mode mattered. |
| `SWR_COMBAT_CARDS` | ON | contingent | 2026-08-06, 1200 RoE | **+1.7pp**. Play Start-of-Combat action cards. Symmetric — needs the per-side form to measure. |
| `SWR_DSUC_GARRISON` | **OFF** | contingent | 2026-08-06, 1200 RoE + 400 vs strong | **REJECTED.** −5.4pp vs heuristic Rebel (38.0→32.6), −2.3pp vs eval-depth2 Rebel (29.8→27.5). Base found 61.4→55.3%. Penalty halves against the stronger opponent and is inside noise at n=400; cost is opponent-independent, so the verdict is fairly robust. |
| `SWR_BUNKERS` | **OFF** | contingent | 2026-08-06, 1200 RoE + 400 vs strong | **REJECTED, weakly.** −2.5pp vs heuristic Rebel, −1.0pp vs eval-depth2 Rebel (inside noise). Lowest-confidence verdict here: the heuristic opponent never attacked the station the Bunker protects, and the penalty more than halves against a stronger one. Also weakly expressed — a Bunker reaches the station in a minority of games. **Re-test against a stronger opponent than eval-depth2.** |
| `SWR_OPPOSE_IDLE` | ON | mechanical | 2026-08-10, 1200 RoE | **Neutral (40.2 → 40.0, two games).** A leader with NO tactic values cannot activate a system by RAW, so the "a leader spent opposing is an activation foregone" skip charges him a price of zero. Exempts Boba Fett / Jabba / Greejatus from it (#704). Empire passes while holding an idle no-tactic leader 27/477 (5.7%) → 3/475 (0.6%); such leaders opposing 2.3% → 7.6%. Passes 7.8 → 7.8 and activations 24.2 → 24.2, so it does not disturb the skip's original purpose. |
| `SWR_DS_CAUTION` | **OFF** | contingent | 2026-08-09, 1200 RoE + 60-game mechanism | **WORKS, BLOCKED.** Stops the Death Star being swept along into reach of Rebel ships (#701). Station moves ending in/beside Rebel ships 69/204 (33.8%) → 5/168 (3.0%), games affected 61.7% → 8.3%, stations lost 8.3% → 6.7%, still moves (168 vs 204). Win rate 40.2% → 40.4% — noise. **Not shipped:** holding it back shrinks what an activation delivers, and on the #639 duplicate-arm fixture that makes the Empire pass 8% of the time (0% without), reproducible. Needs the scorer to price an activation by what will actually move — the same divergence #653 fixed for reinforcements. Self-play also under-values the benefit: the station only dies to a Death Star Plans attempt, which the heuristic Rebel rarely builds on purpose. |
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
   change applies to (`--expansion` for RoE content).
3. Add a row here with the date, sample, mode, and result — including
   rejections. A rejection you didn't write down gets re-implemented later.
4. State the robustness class, and if the result is contingent, say what about
   the opponent it depends on.
