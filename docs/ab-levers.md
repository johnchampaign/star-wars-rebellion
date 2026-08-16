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
| `SWR_BUNKERS` | **OFF** | contingent | 2026-08-06, 1200 RoE + 400 vs strong | **REJECTED, weakly.** −2.5pp vs heuristic Rebel, −1.0pp vs eval-depth2 Rebel (inside noise). Lowest-confidence verdict here: the heuristic opponent never attacked the station the Bunker protects, and the penalty more than halves against a stronger one. Also weakly expressed — a Bunker reaches the station in a minority of games. **Re-test against a stronger opponent than eval-depth2.** |
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
   change applies to (`--expansion` for RoE content).
3. Add a row here with the date, sample, mode, and result — including
   rejections. A rejection you didn't write down gets re-implemented later.
4. State the robustness class, and if the result is contingent, say what about
   the opponent it depends on.
