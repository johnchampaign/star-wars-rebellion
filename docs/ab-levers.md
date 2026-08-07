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
| `SWR_ASSIGN_OPP` | ON | contingent | 2026-08-06, 1200 RoE | **+5.0pp** (33.0→38.0). Largest single gain. Base game showed *nothing* (29.9 vs 29.5) — mode mattered. |
| `SWR_COMBAT_CARDS` | ON | contingent | 2026-08-06, 1200 RoE | **+1.7pp**. Play Start-of-Combat action cards. Symmetric — needs the per-side form to measure. |
| `SWR_DSUC_GARRISON` | **OFF** | contingent | 2026-08-06, 1200 RoE + 400 vs strong | **REJECTED.** −5.4pp vs heuristic Rebel (38.0→32.6), −2.3pp vs eval-depth2 Rebel (29.8→27.5). Base found 61.4→55.3%. Penalty halves against the stronger opponent and is inside noise at n=400; cost is opponent-independent, so the verdict is fairly robust. |
| `SWR_BUNKERS` | **OFF** | contingent | 2026-08-06, 1200 RoE + 400 vs strong | **REJECTED, weakly.** −2.5pp vs heuristic Rebel, −1.0pp vs eval-depth2 Rebel (inside noise). Lowest-confidence verdict here: the heuristic opponent never attacked the station the Bunker protects, and the penalty more than halves against a stronger one. Also weakly expressed — a Bunker reaches the station in a minority of games. **Re-test against a stronger opponent than eval-depth2.** |
| `SWR_NOOP_GUARD` | ON | mechanical | pre-2026-08 (see code) | Sinks activations that provably cannot move or fight (#647). |
| `SWR_SELF_MOVER` | ON | mechanical | pre-2026-08 (see code) | X/Y-Wings move without a carrier; previously 80% of Rebel activations moved nothing. |
| `SWR_ACTIVATE_DIVERSITY` | ON | contingent | pre-2026-08 (see code) | Distinct activation targets per leader (#599). |
| `SWR_ASSIGN_GATE` | ON | contingent | pre-2026-08 (see code) | Don't assign a leader to a mission the Command phase would refuse to reveal. |
| `SWR_EMPIRE_PLANNER` | **OFF** | contingent | pre-2026-08 (see code) | Strike-fleet plan layer (#539). |
| `SWR_HUNT_OCCUPY` | see code | contingent | pre-2026-08 (see code) | Occupy-to-clear base candidates. |

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
