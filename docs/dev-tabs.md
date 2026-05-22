# Dev tabs

Verification & calibration UI for catching data-extraction errors before they
become rules bugs. Hidden by default; enabled by appending `?dev=1` to the URL
(flag persists in `localStorage`). A "hide dev tabs" button in dev mode
switches back. Same pattern and gating as Tyrants.

The dev tabs are the **correction layer** on top of automated extraction from
the .vmod. Bootstrap data is parsed/transcribed from the .vmod's `Map.png`,
`LeaderRebel*.png`, `LeaderEmpire*.png`, `ActionCard*.png`, `Mission*.png`,
`Objective*.png`, `Tactic*.png`, `Probe*.png`. Anything that survives
extraction without you flagging it in a dev tab is treated as canonical.

## Workflow

1. Dev opens the tab.
2. Tab shows the bootstrap value plus a visual reference (cropped card image,
   highlighted map region) for each row.
3. Dev clicks the row to enter edit mode. Saves overwrite that row's
   `assets/*.json` entry; a `provenance` field records `"user-corrected"`
   vs. `"vmod-parsed"`.
4. The full corrected JSON is committed to the repo. End users never see the
   dev tabs.

## Tabs

### `systems` tab

**Purpose:** verify the 32 system records (+Rebel Base space).

**Layout:** scrolling list, one row per system. Each row shows:
- System icon cropped from the board (from the `Region originx/originy` in
  buildFile + a fixed crop radius).
- System name.
- Region ID (1–8).
- `IsRemote` checkbox.
- `IsCoruscant` checkbox.
- Resource icons: list of `{ type: 'space'|'ground', slot: 1|2|3 }`. Visual
  reference: zoomed crop of the system's resource-icon strip from the board.
- "Edit" button → toggles inline editor.

**Edit mode:**
- Toggle `IsRemote` / `IsCoruscant`.
- Add/remove resource icons via dropdown for type + numeric input for slot.
- Save persists to `assets/systems.json` and bumps the row's `provenance`
  to `"user-corrected"`.

### `adjacency` tab

**Purpose:** verify the ~40-edge undirected adjacency graph.

**Layout:** the full board image, with an interactive overlay.

**Default mode (hover-verify):**
- Hovering over a system's region:
  - Highlights the hovered system (gold ring).
  - Highlights all currently-recorded neighbors (green ring).
  - Dims all non-adjacent systems to 30% opacity.
- Tooltip shows the system name and a count: "Mygeeto — 4 neighbors:
  Felucia, Bothawui, Mandalore, Cato Neimoidia".
- This pass is for you to mouse over each of the 32 systems and visually
  confirm the green-ringed set matches the printed board.

**Edit mode (click a system to enter):**
- Selected system gets a persistent gold ring.
- All other systems become click-toggleable.
- Clicking a non-neighbor adds the edge (it joins the green-ring set).
- Clicking a neighbor removes the edge.
- "Save" button commits to `assets/adjacency.json`; "Cancel" reverts.
- Edges are symmetric — toggling A→B also toggles B→A.

**Impassable areas:**
- Light-red impassable regions on the board (rr p.9) are modeled as the
  *absence* of an edge — not as a separate blocker list. If two systems look
  geographically near each other but are separated by an impassable, simply
  don't add the edge.

**Rebel Base space:**
- The Rebel Base space is **not** a system but has its own adjacency for
  unit movement. The base hides in a system, and units in the Rebel Base
  space can move "to either the base's system or systems adjacent to it"
  (rr p.10). This adjacency is computed dynamically at runtime from
  `RebelBaseSystemId`, not stored in `adjacency.json`. Mentioned here only
  so the tab UI doesn't try to render an edge for it.

### `leaders` tab

**Purpose:** verify the skill icons and tactic values for all leaders.

**Layout:** grid, one card per leader, sorted by side then starting-vs-recruit.

Each card shows:
- Cropped leader portrait from `LeaderRebel*.png` / `LeaderEmpire*.png`.
- Leader name.
- Side, IsStarting flag.
- Skill icon row: diplomacy / intel / specOps / logistics counts.
- Tactic values: space, ground.
- Image reference: the original .vmod card image, viewable in a popover for
  side-by-side checking against the parsed values.

**Edit mode:**
- Inline numeric inputs for each skill icon and tactic value.
- Click image popover to zoom for verification.
- Save persists to `assets/leaders.json`.

The `MinorSkills` field is RoE-only; surfaced as a read-only `0` placeholder
that's hidden behind an "Expansion fields" disclosure.

### `cards` tab

**Purpose:** verify rules text and `EffectKey` slugs for all action, mission,
objective, and tactic cards.

**Layout:** filterable list (by kind, by side, by deck), one row per card.

Each row shows:
- Cropped card art.
- Card name, kind, side.
- Parsed rules text.
- `EffectKey` (read-only — must bind to a registered handler in code).
- `Timing` / `IsAttempt` / `IsStarting` / `IsProject` / `Stage` etc.
  depending on kind.
- A handler-bound checkbox: green if an `EffectKey` handler is registered;
  red if not (catches typos and missing handlers).

**Edit mode:**
- Rules text → text area.
- Per-kind metadata fields → typed inputs.
- `EffectKey` → dropdown of registered handler keys (cannot type a free
  string; ensures every card binds).

Save persists to `assets/actions.json`, `assets/missions.json`,
`assets/objectives.json`, `assets/tactics.json` respectively.

### `probe` tab

**Purpose:** sanity check.

**Layout:** simple list of all probe cards (one per system except Coruscant).
Each row maps a probe-card filename to a system ID.

**Asserts visible at the top:**
- ✅ 31 probe cards.
- ✅ No card for Coruscant.
- ✅ One card per non-Coruscant system; every non-Coruscant system has exactly
  one card.

If any of those fail, the corresponding row is highlighted red. Edit mode
lets you re-bind a probe card to a different system.

## Provenance model

Every record in every `assets/*.json` has a `provenance` field:

```json
{
  "id": "mon-mothma",
  "name": "Mon Mothma",
  "skills": { "diplomacy": 3, "intel": 0, "specOps": 0, "logistics": 0 },
  "tacticValues": { "space": 0, "ground": 0 },
  "provenance": "user-corrected",
  "_source": "vmod:images/LeaderRebelMonMothma.png"
}
```

- `"vmod-parsed"` — directly extracted from the .vmod with no human review.
- `"user-corrected"` — opened, possibly edited, saved through a dev tab.

The build runs a `verify-provenance` script before tagging a release: any
record still tagged `"vmod-parsed"` triggers a warning ("23 records not yet
user-verified") but does not block.

## Out of dev tabs

These are calibration-style tabs only. Game-state debugging (current player,
hand contents, deck order) belongs on a separate `debug` tab if needed
later — same gate, different concerns. Don't conflate.

## Why not just inspect the JSON files?

Three reasons, all lifted from Tyrants:

1. **Visual reference adjacency.** Looking at a JSON row says
   `"mon-calamari": ["nal-hutta", "bothawui", "dac"]`. Looking at the board
   with the neighbors highlighted in green says the same thing in 1 second.
   The hover-verify pass over 32 systems takes about 5 minutes total.
2. **Closed-loop correction.** Fixing in a text editor means rebuilding,
   reloading, and re-checking. Fixing inline in the dev tab persists
   immediately to JSON and re-renders.
3. **Handler binding for cards.** A dropdown of registered `EffectKey`s
   makes it impossible to ship a card pointing at a missing handler.
