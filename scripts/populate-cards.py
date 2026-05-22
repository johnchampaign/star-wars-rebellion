"""Populate assets/{actions,missions,objectives,tactics}.json from the
user-provided reference materials. Run after extract-cards.mjs.

Reference data is embedded as Python dicts below (transcribed from the
reference PDFs/docx/xlsx). To fix a wrong entry, edit the dict here and rerun.

Each populated card record gets provenance: "reference-derived" so the cards
dev tab can flag them for spot-checking.

Usage:
    python scripts/populate-cards.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
ASSETS = ROOT / "assets"

# ============================================================================
# TACTIC CARDS — from Combat_Cards.pdf
# Keyed by (theater, kebab-name) matching extract-cards.mjs id format.
# ============================================================================

TACTICS = {
    # ----- ground (10 unique, 15 total) -----
    ("ground", "bombardment"): {
        "rulesText": "Deal damage equal to the red attack value of 1 of your ships",
        "requiresSpecial": True,
        "copies": 1,
    },
    ("ground", "brilliant-strategy"): {
        "rulesText": "Draw 2 tactic cards from either deck, or 1 from each",
        "requiresSpecial": True,
        "copies": 1,
    },
    ("ground", "concentrate-fire"): {
        "rulesText": "Reroll up to 2 of your dice",
        "requiresSpecial": False,
        "copies": 2,
    },
    ("ground", "critical-hit"): {
        "rulesText": "Deal 1 damage",
        "requiresSpecial": False,
        "copies": 2,
    },
    ("ground", "defensive-formation"): {
        "rulesText": "Block 1 damage",
        "requiresSpecial": False,
        "copies": 3,
    },
    ("ground", "dig-in"): {
        "rulesText": "Discard 1 ground tactic card from your hand to block up to 2 damage",
        "requiresSpecial": False,
        "copies": 2,
    },
    ("ground", "escape-plan"): {
        "rulesText": "During this combat round, your units can retreat ignoring transport restrictions",
        "requiresSpecial": False,
        "copies": 1,
    },
    ("ground", "onslaught"): {
        "rulesText": "Deal 1 damage to up to 2 different ground units",
        "requiresSpecial": True,
        "copies": 1,
    },
    ("ground", "take-it-down"): {
        "rulesText": "Deal 2 damage to 1 ground unit",
        "requiresSpecial": True,
        "copies": 1,
    },
    ("ground", "unstoppable-assault"): {
        "rulesText": "During this ground battle step, your opponent cannot block damage",
        "requiresSpecial": True,
        "copies": 1,
    },
    # ----- space (9 unique, 15 total) -----
    ("space", "brilliant-strategy"): {
        "rulesText": "Draw 2 tactic cards from either deck, or 1 from each",
        "requiresSpecial": True,
        "copies": 1,
    },
    ("space", "no-escape"): {
        "rulesText": "During this combat round, your opponent cannot retreat",
        "requiresSpecial": False,
        "copies": 1,
    },
    ("space", "concentrate-fire"): {
        "rulesText": "Reroll up to 2 of your dice",
        "requiresSpecial": False,
        "copies": 2,
    },
    ("space", "critical-hit"): {
        "rulesText": "Deal 1 damage",
        "requiresSpecial": False,
        "copies": 2,
    },
    ("space", "defensive-formation"): {
        "rulesText": "Block 1 damage",
        "requiresSpecial": False,
        "copies": 3,
    },
    ("space", "onslaught"): {
        # User-confirmed: Combat_Cards.pdf had a typo saying "ground units";
        # the printed space card says "ships".
        "rulesText": "Deal 1 damage to up to 2 different ships.",
        "requiresSpecial": True,
        "copies": 1,
    },
    ("space", "outmaneuver"): {
        "rulesText": "Discard 1 space tactic card from your hand to block up to 2 damage",
        "requiresSpecial": False,
        "copies": 2,
    },
    ("space", "take-it-down"): {
        "rulesText": "Deal 2 damage to 1 ship",
        "requiresSpecial": True,
        "copies": 2,
    },
    ("space", "unstoppable-assault"): {
        # User-confirmed: Combat_Cards.pdf had a typo saying "ground battle step";
        # the printed space card says "space battle step".
        "rulesText": "During this space battle step, your opponent cannot block damage.",
        "requiresSpecial": True,
        "copies": 1,
    },
}

# ============================================================================
# OBJECTIVE CARDS — from REBEL_OBJ.pdf + Important_Card_Reference_v1.1.pdf
# Keyed by id-with-stage-suffix matching extract-cards.mjs.
# ============================================================================

OBJECTIVES = {
    "cut-supply-lines-1": {
        "reputation": 1, "timing": "StartOfRefresh",
        "rulesText": "At least 3 Imperial systems contain either a sabotage marker or a Rebel unit.",
    },
    "defend-the-people-1": {
        "reputation": 1, "timing": "StartOfRefresh",
        "rulesText": "At least 4 Rebel systems contain a Rebel unit.",
    },
    "regional-support-1": {
        "reputation": 1, "timing": "StartOfRefresh",
        "rulesText": "All populous systems in 1 region have Rebel loyalty.",
    },
    "rebel-assault-1": {
        "reputation": 1, "timing": "Combat",
        "rulesText": "A Star Destroyer or Super Star Destroyer has been destroyed in a combat that you initiated.",
    },
    "crippling-blow-1": {
        "reputation": 1, "timing": "Combat",
        "rulesText": "At least 3 health worth of Imperial ground units have been destroyed in a combat that you initiated.",
    },
    "popular-support-2": {
        "reputation": 1, "timing": "StartOfRefresh",
        "rulesText": "If at least 6 systems have Rebel loyalty.",
    },
    "heart-of-the-empire-2": {
        "reputation": 2, "timing": "StartOfRefresh",
        "rulesText": "If the Coruscant system contains a Rebel unit and no Imperial units. Then return this card to your hand.",
    },
    "liberation-2": {
        "reputation": 1, "timing": "Combat",
        "rulesText": "If you win a ground battle in a subjugated system.",
    },
    "leave-no-one-behind-2": {
        "reputation": 1, "timing": "StartOfRefresh",
        "rulesText": "If there are no captured Rebel leaders.",
    },
    "death-star-plans-2": {
        "reputation": 2, "timing": "Combat",
        "rulesText": "If there is at least 1 fighter after the space battle step, reveal this card to roll 3 dice. If you roll a direct hit, play this card and destroy a Death Star in this system. Otherwise return this card to your hand.",
    },
    "return-of-the-jedi-3": {
        "reputation": 2, "timing": "Combat",
        "rulesText": "After you win a battle in Darth Vader's or Emperor Palpatine's system. If Luke Skywalker (Jedi) is in this system, eliminate 1 Imperial leader in this system.",
    },
    "major-victory-3": {
        "reputation": 1, "timing": "Combat",
        "rulesText": "At least 3 health worth of Imperial ships have been destroyed in a combat that you initiated.",
    },
    "inspire-sympathy-3": {
        "reputation": 0,  # variable: * means "1 per destroyed system"
        "timing": "StartOfRefresh",
        "rulesText": "Gain 1 reputation for each destroyed system. [Variable reputation; field 'reputation' here is 0 as a placeholder.]",
    },
    "establish-outposts-3": {
        "reputation": 1, "timing": "StartOfRefresh",
        "rulesText": "At least 5 systems contain a Rebel unit.",
    },
    "death-star-plans-3": {
        "reputation": 2, "timing": "Combat",
        "rulesText": "If there is at least 1 fighter after the space battle step, reveal this card to roll 3 dice. If you roll a direct hit, play this card and destroy a Death Star in this system. Otherwise return this card to your hand.",
    },
}

# ============================================================================
# ACTION CARDS — from Rebel/Imperial_Leader_Action_Cards.docx + Rebellion_v3.xlsx
# Keyed by kebab-name (same as scaffold id).
# ============================================================================

# isStarting is set on scaffold via filename heuristic; we override only where
# needed. timing values: Assignment | StartOfCombat | Immediate | Special.

ACTIONS = {
    # ===== Rebel starting =====
    "resourceful-astromech": {
        "timing": "Immediate", "leaderRequirement": [],
        "rulesText": "R2-D2 ring — discard to turn 1 opponent's die to the blank side.",
        "isStarting": True,
    },
    "human-cyborg-relations": {
        "timing": "Immediate", "leaderRequirement": [],
        "rulesText": "C-3PO ring — discard to automatically succeed at a diplomacy mission after failure.",
        "isStarting": True,
    },
    "temporary-alliance": {
        "timing": "Assignment", "leaderRequirement": ["mon-mothma"],
        "rulesText": "Place this leader in a neutral system to add that system's units to the build queue.",
        "isStarting": True,
    },
    "rebel-planning": {
        "timing": "Assignment", "leaderRequirement": ["jan-dodonna"],
        "rulesText": "Place this leader in the \"Rebel Base\" space to draw 1 objective card.",
        "isStarting": True,
    },
    "start-the-evacuation": {
        "timing": "Assignment", "leaderRequirement": ["general-rieekan"],
        "rulesText": "Move units from the Rebel Base to any system without Imperial units during the assignment phase.",
        "isStarting": True,
    },
    "our-most-desperate-hour": {
        "timing": "Assignment", "leaderRequirement": ["princess-leia"],
        "rulesText": "Search the assignment deck for a card and put Leia on it.",
        "isStarting": True,
    },
    # ===== Rebel recruit =====
    "its-a-trap": {
        "timing": "StartOfCombat", "leaderRequirement": ["admiral-ackbar"],
        "rulesText": "During the first round of combat, your opponent cannot play space tactic cards.",
        "isStarting": False,
    },
    "point-blank-assault": {
        "timing": "StartOfCombat", "leaderRequirement": ["admiral-ackbar", "general-madine"],
        "rulesText": "All units in the system have -1 health, to a minimum of 1.",
        "isStarting": False,
    },
    "wookie-guardian": {
        "timing": "Special", "leaderRequirement": ["chewbacca"],
        "rulesText": "Use when your opponent attempts a Spec Ops mission — it automatically fails.",
        "isStarting": False,
    },
    "the-milleninium-falcon": {  # filename misspells: TheMilleniniumFalcon — matching scaffold id
        "timing": "Immediate", "leaderRequirement": ["han-solo", "chewbacca"],
        "rulesText": "Add the \"Millennium Falcon\" ring — automatically rescue 1 captured leader in a system after a successful mission there.",
        "isStarting": False,
    },
    "ambush": {
        "timing": "Assignment", "leaderRequirement": ["general-madine"],
        "rulesText": "Place this leader in a system to destroy up to 3 health of Imperial ground units.",
        "isStarting": False,
    },
    "an-old-friend": {
        "timing": "Assignment", "leaderRequirement": ["han-solo"],
        "rulesText": "Place this leader in Bespin or Kashyyyk to recruit Lando or Chewbacca.",
        "isStarting": False,
    },
    "independent-operation": {
        "timing": "Assignment", "leaderRequirement": ["lando-calrissian"],
        "rulesText": "Place this leader in a subjugated system in the assignment phase. All Imperial ground units there must be moved to one Imperial system of their choice.",
        "isStarting": False,
    },
    "undercover": {
        "timing": "Special", "leaderRequirement": ["lando-calrissian", "obi-wan-kenobi"],
        "rulesText": "When the opponent attempts a mission, move this leader from any system to that system to help oppose it.",
        "isStarting": False,
    },
    "son-of-skywalker": {
        "timing": "Special", "leaderRequirement": ["luke-skywalker"],
        "rulesText": "After a successful mission, search the mission deck for \"Seek Yoda\" or \"Daring Rescue\" card.",
        "isStarting": False,
    },
    "one-in-a-million": {
        "timing": "Special", "leaderRequirement": ["luke-skywalker", "wedge-antilles"],
        "rulesText": "Use during a combat or mission — instead of rolling up to two dice, place them on the table showing results of your choice. Can be used to roll an automatic success with the \"Death Star Plans\" objective.",
        "isStarting": False,
    },
    "noble-sacrifice": {
        "timing": "Special", "leaderRequirement": ["obi-wan-kenobi"],
        "rulesText": "Use when this leader becomes captured. He is eliminated, and you gain 1 reputation.",
        "isStarting": False,
    },
    "target-the-star-destroyers": {
        "timing": "StartOfCombat", "leaderRequirement": ["wedge-antilles"],
        "rulesText": "During the space battle of each combat round, treat up to 2 of your black hits as red hits.",
        "isStarting": False,
    },

    # ===== Empire starting =====
    "according-to-my-design": {
        "timing": "StartOfCombat", "leaderRequirement": ["emperor-palpatine"],
        "rulesText": "Rebel player rolls 1 fewer red die and 2 fewer black dice for the first round of air and ground combat.",
        "isStarting": True,
    },
    "it-is-your-destiny": {
        "timing": "Special", "leaderRequirement": ["darth-vader"],
        "rulesText": "Use during a mission after a leader is rescued. Capture 1 leader who attempted the mission.",
        "isStarting": True,
    },
    "more-dangerous-than-you-realize": {
        "timing": "StartOfCombat", "leaderRequirement": ["general-tagge"],
        "rulesText": "Draw either 3 space tactic or 3 ground tactic cards.",
        "isStarting": True,
    },
    "brilliant-administrator": {
        "timing": "Assignment", "leaderRequirement": ["grand-moff-tarkin"],
        "rulesText": "Place this leader in an Imperial system and immediately build with it.",
        "isStarting": True,
    },
    # ===== Empire recruit =====
    "catch-them-by-surprise": {
        "timing": "Assignment", "leaderRequirement": ["admiral-ozzel"],
        "rulesText": "Move a fleet immediately (i.e. in the assignment phase, before the Rebels have a chance to move).",
        "isStarting": False,
    },
    "proceeding-as-planned": {
        "timing": "Assignment", "leaderRequirement": ["admiral-ozzel", "moff-jerjerrod"],
        "rulesText": "Search the project deck for 1 project and assign this leader to it.",
        "isStarting": False,
    },
    "keep-them-from-escaping": {
        "timing": "StartOfCombat", "leaderRequirement": ["admiral-piett"],
        "rulesText": "Rebel units cannot retreat.",
        "isStarting": False,
    },
    "ready-for-action": {
        "timing": "StartOfCombat", "leaderRequirement": ["admiral-piett", "general-veers"],
        "rulesText": "Take a leader from the leader pool, place in combat, and get him back at end of fight.",
        "isStarting": False,
    },
    "boba-fett-where": {
        "timing": "Assignment", "leaderRequirement": ["boba-fett"],
        "rulesText": "Place this leader in an Imperial system — Rebels cannot attempt missions or use action cards here.",
        "isStarting": False,
    },
    "blindside": {
        "timing": "Special", "leaderRequirement": ["boba-fett", "janus-greejatus"],
        "rulesText": "Opponent cannot send leaders from his leader pool to oppose this leader's mission.",
        "isStarting": False,
    },
    "local-rumors": {
        "timing": "Assignment", "leaderRequirement": ["colonel-yularen"],
        "rulesText": "Place this leader in any system with an Imperial unit. Rebel player must state whether the Rebel base is in that region.",
        "isStarting": False,
    },
    "good-intel": {
        "timing": "StartOfCombat", "leaderRequirement": ["colonel-yularen", "soontir-fel"],
        "rulesText": "Rebel player must keep tactic cards faceup.",
        "isStarting": False,
    },
    "target-the-generator": {
        "timing": "StartOfCombat", "leaderRequirement": ["general-veers"],
        "rulesText": "Destroy 1 structure in the system.",
        "isStarting": False,
    },
    "public-support": {
        "timing": "Assignment", "leaderRequirement": ["janus-greejatus"],
        "rulesText": "Place this leader in an Imperial system without Rebel ground units — gain 3 Stormtroopers. Janus does not stop units from moving out of the system this turn.",
        "isStarting": False,
    },
    "fully-operational": {
        "timing": "StartOfCombat", "leaderRequirement": ["moff-jerjerrod"],
        "rulesText": "If either a Death Star or Death Star Under Construction is in this system, destroy 1 Rebel ship of your choice in the system.",
        "isStarting": False,
    },
    "scouting-mission": {
        "timing": "Assignment", "leaderRequirement": [],
        "rulesText": "Place this leader in any system. Then move up to 4 TIE Fighters from any system(s) to this system, ignoring transport restrictions and adjacency. If there are Rebel ships in this system, resolve a combat.",
        "isStarting": False,
    },
}

# ============================================================================
# MISSION CARDS — from SWR_Mission_Reference.pdf + Important_Card_Reference_v1.1.pdf
# Keyed by kebab-name (matches scaffold id).
# ============================================================================

MISSIONS = {
    # ===== Rebel starting =====
    "sabotage": {
        "skill": "specOps", "skillCost": 1, "isAttempt": True, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Attempt in any system. If successful, place a sabotage marker in this system. This marker prevents players from building units and deploying units in this system.",
    },
    "build-alliance": {
        "skill": "diplomacy", "skillCost": 1, "isAttempt": True, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Attempt in any populous system. If there are Rebel units in this system, roll 2 additional dice. If successful, gain 1 loyalty in this system.",
    },
    "rapid-mobilization": {
        "skill": "logistics", "skillCost": 1, "isAttempt": False, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Resolve in the \"Rebel Base\" space. At the end of this phase, choose 1 of the following: If the Rebel base is not revealed, move up to 5 units from 1 system to the \"Rebel Base\" space, ignoring adjacency. Establish a new Rebel Base. If 2 leaders are assigned to this mission, draw 8 probe cards instead of 4.",
    },
    "infiltration": {
        "skill": "intel", "skillCost": 1, "isAttempt": True, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Attempt in any system that contains an Imperial unit. If successful, look at the top 2 cards of the objective deck. Place 1 card on the top of the deck and the other card on the bottom.",
    },
    # ===== Rebel regular =====
    "base-defenses": {
        "skill": "diplomacy", "skillCost": 1, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "general-rieekan",
        "rulesText": "Attempt in any Rebel system. If successful, gain 1 Ion Cannon and 1 Shield Generator in the \"Rebel Base\" space.",
    },
    "ignite-rebellion": {  # .vmod filename uses "Ignite" (canonical), not "Incite" — reference PDF may have typo
        "skill": "diplomacy", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any subjugated system. If successful, gain 3 Rebel Troopers in this system. Then resolve a combat.",
    },
    "support-of-mon-calamari": {
        "skill": "diplomacy", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "admiral-ackbar",
        "rulesText": "Attempt in the Mon Calamari system. If successful, either gain 2 loyalty in this system or place 1 Mon Calamari Cruiser on space 3 of the build queue.",
    },
    "public-uprising": {
        "skill": "diplomacy", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any subjugated system. If successful, gain 1 circle and 2 triangle units (ships and/or ground units) in the system. Then resolve a combat.",
    },
    "establish-trade-relations": {
        "skill": "diplomacy", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "mon-mothma",
        "rulesText": "Attempt in any system that does not contain a sabotage marker. If successful, gain 1 loyalty in the system and place units on the build queue using this system's resource icons and number.",
    },
    "seek-yoda": {
        "skill": "intel", "skillCost": 1, "isAttempt": False, "isStarting": False,
        "leaderPortrait": "luke-skywalker",
        "rulesText": "Resolve in the Dagobah system. Attach the Master Yoda ring to this leader. Once per game round, when this leader is in the same system as a mission or combat, you may reroll 1 of your dice. If Luke Skywalker resolves this mission, also replace his leader with Luke Skywalker (Jedi).",
    },
    "daring-rescue": {
        "skill": "intel", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any system that contains a captured leader. If successful, rescue that leader.",
    },
    "plan-the-assault": {
        "skill": "intel", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "jan-dodonna",
        "rulesText": "Attempt in any system that contains an Imperial ship. If successful, move ships (but not ground units) from the \"Rebel Base\" space to this system as if they were adjacent. Leaders in the \"Rebel Base\" space do not prevent this movement. Then resolve a combat in this system.",
    },
    "stolen-plans": {
        "skill": "intel", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "princess-leia",
        "rulesText": "Attempt in any system that contains an Imperial unit. If successful, look at the top 4 cards of the objective deck. Place those cards on top of the deck in any order.",
    },
    "covert-operation": {
        "skill": "intel", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any system that contains Imperial units. If successful, draw 2 objective cards. Keep 1 and place the other on the bottom of the deck.",
    },
    "for-the-greater-good": {
        "skill": "intel", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "obi-wan-kenobi",
        "rulesText": "Attempt in any system that contains a captured leader. If successful, rescue that leader and draw 1 objective card. The leader(s) assigned to this mission remain in this system.",
    },
    "misdirection": {
        "skill": "specOps", "skillCost": 1, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "general-madine",
        "rulesText": "Attempt in any system that contains an Imperial unit. If successful, choose 1 of your leaders. Imperial leaders in the leader pool cannot be sent to oppose this leader's mission this round.",
    },
    "hit-and-run": {
        "skill": "specOps", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any system. If successful, destroy up to 2-health worth of units of your choice in this system.",
    },
    "lead-the-strike-team": {
        "skill": "specOps", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "han-solo",
        "rulesText": "Attempt in any system. If successful, move up to 4 ground units from the \"Rebel Base\" space to this system, ignoring transport restriction and adjacency. If there are Imperial ground units in this system, resolve a combat.",
    },
    "rogue-squadron-raid": {
        "skill": "specOps", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "wedge-antilles",
        "rulesText": "Attempt in any Imperial system. If successful, destroy up to 4 health worth of units of your choice on the build queue.",
    },
    "demolition": {
        "skill": "specOps", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any Imperial system. If successful, for each of this system's resource icons destroy 1 unit on the build queue that matches the icon.",
    },
    "wookie-uprising": {
        "skill": "specOps", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "chewbacca",
        "rulesText": "Attempt in the Kashyyyk system. If successful, gain 1 loyalty in this system and destroy up to 4 health worth of units of your choice in this system.",
    },
    "contingency-plan": {
        "skill": "logistics", "skillCost": 1, "isAttempt": False, "isStarting": False,
        "leaderPortrait": "lando-calrissian",
        "rulesText": "Assign this leader to a starting mission from your hand, even one that was already attempted or resolved this round. If Lando Calrissian was assigned to this mission, he gains 2 additional successes when he attempts a mission later this round.",
    },
    "hidden-fleet": {
        "skill": "logistics", "skillCost": 3, "isAttempt": False, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Resolve in any system that does not contain an Imperial unit. Move units from the \"Rebel Base\" space to this system as if they were adjacent. Leaders in the \"Rebel Base\" space do not prevent this movement.",
    },
    "plant-false-lead": {
        "skill": "logistics", "skillCost": 1, "isAttempt": False, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Resolve in any system that contains an Imperial unit. Randomly take 4 of the Imperial player's probe cards. Place these cards on the top and/or bottom of the deck in any order without showing them to the Imperial player.",
    },

    # ===== Imperial starting =====
    "capture-rebel-operative": {
        "skill": "specOps", "skillCost": 1, "isAttempt": True, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Attempt against a Rebel leader that is in a system that contains an Imperial unit. If successful, capture that leader.",
    },
    "gather-intel": {
        "skill": "intel", "skillCost": 1, "isAttempt": True, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Attempt in any Rebel system. If successful, draw 1 probe card for every 4 Rebel units at the Rebel base (minimum of 1 card).",
    },
    "research-and-development": {
        "skill": "logistics", "skillCost": 1, "isAttempt": False, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Resolve in any system that has Imperial loyalty. Choose one of the following: Draw 2 project cards. Choose 1 to keep and place the other on the bottom of the deck. Remove a sabotage marker from this system and draw 1 project card.",
    },
    "rule-by-fear": {
        "skill": "diplomacy", "skillCost": 1, "isAttempt": True, "isStarting": True,
        "leaderPortrait": None,
        "rulesText": "Attempt in any populous system that contains an Imperial unit. If successful, gain 1 loyalty in this system.",
    },

    # ===== Imperial Projects =====
    "construct-death-star": {
        "skill": "logistics", "skillCost": 1, "isAttempt": False, "isStarting": False, "isProject": True,
        "leaderPortrait": None,
        "rulesText": "Resolve in a remote system that does not contain a Rebel unit. Gain 1 Death Star Under Construction in this system and place 1 Death Star on space 3 of the build queue. When the Death Star is deployed, it replaces the Death Star Under Construction.",
    },
    "construct-factory": {
        "skill": "logistics", "skillCost": 2, "isAttempt": False, "isStarting": False, "isProject": True,
        "leaderPortrait": None,
        "rulesText": "Resolve in any Imperial system. Place units on the build queue using this system's resource icons and number. If there is a sabotage marker in this system, remove the marker before resolving this ability.",
    },
    "construct-super-star-destroyer": {
        "skill": "logistics", "skillCost": 2, "isAttempt": False, "isStarting": False, "isProject": True,
        "leaderPortrait": None,
        "rulesText": "Resolve in any Imperial system that has a blue square resource icon. Place 1 Super Star Destroyer on space 3 of the build queue.",
    },
    "oversee-project": {
        "skill": "logistics", "skillCost": 2, "isAttempt": False, "isStarting": False, "isProject": True,
        "leaderPortrait": None,
        "rulesText": "Resolve in any system that contains an Imperial unit and no Rebel units. Choose 1 Imperial unit on space 1 or 2 of the build queue and deploy it in this system.",
    },
    "superlaser-online": {
        "skill": "logistics", "skillCost": 3, "isAttempt": False, "isStarting": False, "isProject": True,
        "leaderPortrait": None,
        "rulesText": "Resolve in any system that contains a Death Star. Destroy this system and gain 1 loyalty in 1 populous system in this region.",
    },

    # ===== Imperial regular =====
    "double-our-efforts": {
        "skill": "diplomacy", "skillCost": 1, "isAttempt": False, "isStarting": False,
        "leaderPortrait": "moff-jerjerrod",
        "rulesText": "Resolve in any Imperial system. Choose 1 unit on space 2 or 3 of the build queue and move it down 1 space. If Moff Jerjerrod resolves this mission, you can choose 1 additional unit.",
    },
    "fear-will-keep-them-in-line": {
        "skill": "diplomacy", "skillCost": 1, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "grand-moff-tarkin",
        "rulesText": "Attempt in any system that contains a Death Star, Star Destroyer or Super Star Destroyer. If successful, gain 1 loyalty in 2 systems in this region.",
    },
    "imperial-propaganda": {
        "skill": "diplomacy", "skillCost": 1, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "janus-greejatus",
        "rulesText": "Attempt in any Imperial system. If successful, each system in this region that has Rebel loyalty becomes neutral.",
    },
    "trade-negotiations": {
        "skill": "diplomacy", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any populous system. If successful, gain 1 loyalty in this system.",
    },
    "display-of-power": {
        "skill": "diplomacy", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any populous system. If successful, gain 2 loyalty in this system.",
    },
    "lure-of-the-dark-side": {
        "skill": "diplomacy", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "emperor-palpatine",
        "rulesText": "Attempt against a captured leader. Count all skill icons during this attempt. If successful, attach the Lure of the Dark Side ring to the Rebel leader. It becomes an Imperial leader for the rest of the game. If successful against Luke Skywalker, the Rebel player loses 1 reputation.",
    },
    "probe-droid-initiative": {
        "skill": "intel", "skillCost": 1, "isAttempt": False, "isStarting": False,
        "leaderPortrait": "admiral-ozzel",
        "rulesText": "Resolve in any system that contains a Star Destroyer or Super Star Destroyer. Draw 2 cards from the probe deck. If Admiral Ozzel resolves this mission, draw 2 additional cards.",
    },
    "intercept-transmissions": {
        "skill": "intel", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt in any Rebel system. If successful, the Rebel player draws 8 cards from the probe deck. He gives you all cards belonging to systems that contain an Imperial unit. Then he shuffles the other cards back into the deck.",
    },
    "long-range-probe": {
        "skill": "intel", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "admiral-piett",
        "rulesText": "Attempt in any system. If successful, the Rebel player must tell you if the Rebel base is in this system.",
    },
    "homing-beacon": {
        "skill": "intel", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt against a captured leader. If successful, this leader is rescued. The Rebel player must place this leader in any system in the Rebel base's region.",
    },
    "interrogation-droid": {
        "skill": "intel", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "colonel-yularen",
        "rulesText": "Attempt against a captured leader. Count all skill icons during this attempt. If successful, the Rebel player must name 3 systems. One of these systems must contain the Rebel base.",
    },
    "detained": {
        "skill": "specOps", "skillCost": 1, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "general-tagge",
        "rulesText": "Attempt against a Rebel leader that is in any system. If successful, that leader does not return to the leader pool during the next refresh phase.",
    },
    "hunt-them-down": {
        "skill": "specOps", "skillCost": 1, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "soontir-fel",
        "rulesText": "Attempt in any system. If successful, destroy up to 2-health worth of units of your choice in the system.",
    },
    "interrogation": {
        "skill": "specOps", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt against a captured leader. If successful, the Rebel player must reveal his hand of objective cards.",
    },
    "planetary-conquest": {
        "skill": "specOps", "skillCost": 2, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "general-veers",
        "rulesText": "Attempt in any system. If successful, move up to 1 AT-AT, 1 AT-ST and 2 Stormtroopers from any one system to this system, ignoring transport restrictions and adjacency. If there are Rebel ground units in this system, resolve a combat.",
    },
    "carbon-freezing": {
        "skill": "specOps", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Attempt against a captured leader. If successful, attach the Carbonite ring to that leader, and the Rebel player loses 1 reputation. This leader is considered captured. When rescued, discard this attachment ring.",
    },
    "collect-bounty": {
        "skill": "specOps", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "boba-fett",
        "rulesText": "Attempt against a Rebel leader that is in any system. If successful, capture that leader. Then move both that leader and this leader to the closest system that contains an Imperial unit.",
    },
    "retrieve-the-plans": {
        "skill": "specOps", "skillCost": 3, "isAttempt": True, "isStarting": False,
        "leaderPortrait": "darth-vader",
        "rulesText": "Attempt against a captured leader. If successful, the Rebel player must reveal his hand of objective cards. Choose 1 of these cards to place on the bottom of the objective deck.",
    },
    "address-delays": {
        "skill": "logistics", "skillCost": 2, "isAttempt": False, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Resolve in any Imperial system. Place units on the build queue using this system's resource icons and number.",
    },
    "secret-weapons-research": {
        "skill": "logistics", "skillCost": 2, "isAttempt": False, "isStarting": False,
        "leaderPortrait": None,
        "rulesText": "Resolve in any Imperial system. Draw 2 project cards.",
    },
}


# ============================================================================
# Apply
# ============================================================================

def load(name):
    return json.loads((ASSETS / f"{name}.json").read_text(encoding="utf-8"))

def save(name, data):
    (ASSETS / f"{name}.json").write_text(json.dumps(data, indent=2), encoding="utf-8")

def stamp_meta(meta, count):
    meta["provenance"] = "reference-derived"
    note = f"Populated by scripts/populate-cards.py from user-provided reference materials ({count} entries matched)."
    if note not in meta["notes"]:
        meta["notes"].append(note)


def populate_tactics():
    data = load("tactics")
    matched = 0
    unmatched = []
    for t in data["tactics"]:
        key = (t["theater"], t["id"].split("-", 1)[1])  # strip "ground-"/"space-" prefix
        ref = TACTICS.get(key)
        if not ref:
            unmatched.append(t["id"])
            continue
        t["rulesText"] = ref["rulesText"]
        t["requiresSpecial"] = ref["requiresSpecial"]
        t["copies"] = ref["copies"]
        matched += 1
    stamp_meta(data["_meta"], matched)
    save("tactics", data)
    return matched, unmatched


def populate_objectives():
    data = load("objectives")
    matched = 0
    unmatched = []
    for o in data["objectives"]:
        ref = OBJECTIVES.get(o["id"])
        if not ref:
            unmatched.append(o["id"])
            continue
        o["reputation"] = ref["reputation"]
        o["timing"] = ref["timing"]
        o["rulesText"] = ref["rulesText"]
        matched += 1
    stamp_meta(data["_meta"], matched)
    save("objectives", data)
    return matched, unmatched


def populate_actions():
    data = load("actions")
    matched = 0
    unmatched = []
    for a in data["actions"]:
        ref = ACTIONS.get(a["id"])
        if not ref:
            unmatched.append(a["id"])
            continue
        a["timing"] = ref["timing"]
        a["leaderRequirement"] = ref["leaderRequirement"]
        a["rulesText"] = ref["rulesText"]
        a["isStarting"] = ref["isStarting"]
        matched += 1
    stamp_meta(data["_meta"], matched)
    save("actions", data)
    return matched, unmatched


def populate_missions():
    data = load("missions")
    matched = 0
    unmatched = []
    for m in data["missions"]:
        ref = MISSIONS.get(m["id"])
        if not ref:
            unmatched.append(m["id"])
            continue
        m["skill"] = ref["skill"]
        m["skillCost"] = ref["skillCost"]
        m["isAttempt"] = ref["isAttempt"]
        m["isStarting"] = ref["isStarting"]
        m["leaderPortrait"] = ref["leaderPortrait"]
        m["rulesText"] = ref["rulesText"]
        # isProject only set if reference explicitly states; otherwise leave scaffold default
        if "isProject" in ref:
            m["isProject"] = ref["isProject"]
        matched += 1
    stamp_meta(data["_meta"], matched)
    save("missions", data)
    return matched, unmatched


def main():
    for name, fn in [("tactics", populate_tactics),
                     ("objectives", populate_objectives),
                     ("actions", populate_actions),
                     ("missions", populate_missions)]:
        matched, unmatched = fn()
        print(f"{name:10s}: {matched} populated", end="")
        if unmatched:
            print(f"  |  {len(unmatched)} unmatched: {', '.join(unmatched)}")
        else:
            print()


if __name__ == "__main__":
    main()
