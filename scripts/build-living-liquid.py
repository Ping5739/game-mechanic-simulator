"""
Builds the Living Liquid encounter + "APT" strategy JSON from positions taken
from Elina's Toolbox Gaming plan (https://ff14.toolboxgaming.space/?id=725383877116761).

Positions come from the plan (a 15x15 grid, converted to world units with an
arena radius of 20). Cast times and mechanic rules come from the Living Liquid
timeline and mechanics sections of Lyra's TEA guide
(https://docs.google.com/document/d/1wKE4Hj7asv5PsJT4w4mL5chDRMTtgUbdPCsJWqGsuJk).
AoE sizes aren't in either source; they're scaled from the plan's drawings.

Run:  python3 scripts/build-living-liquid.py
"""
import json, pathlib

S = 20 / 7.5  # world units per grid square
def W(gx, gy):
    return {"x": round((gx - 7.5) * S, 2), "y": round((gy - 7.5) * S, 2)}
def g(n):  # grid distance -> world distance
    return round(n * S, 2)

# Plan jobs -> party slots (MT=DRK, OT=GNB, M1=DRG, M2=NIN per the plan's notes;
# AST = regen healer (H1), SCH = shield healer (H2), BRD = ranged (R1), BLM = caster (R2)).
ORDER = ["MT", "OT", "H1", "H2", "M1", "M2", "R1", "R2"]
def P(drk, gnb, ast, sch, drg, nin, brd, blm):
    return {s: W(*xy) for s, xy in zip(ORDER, [drk, gnb, ast, sch, drg, nin, brd, blm])}

# (time the step should be reached, label, short note in our own words, positions)
steps = [
    (18, "Cascade", "Tornadoes appear west, east and south; the open side counts as north. Stack in the middle.",
     P((7.4,6), (7.43,8.73), (8.73,9.18), (6.1,8.98), (6.38,8.05), (8.55,7.95), (6.9,9.3), (7.93,9.35))),
    (30, "Split bosses", "MT drags Living Liquid south-west by the south tornado; OT takes the Hand the other way so Hand of Parting/Prayer needs them together. Caster heads to bait the west tornado, ranged the east one.",
     P((3.98,13.48), (9.13,5.2), (6.9,3.85), (11.13,11), (7.5,6.83), (8.23,7.48), (12.58,4), (2.85,4.2))),
    (32, "Tornado proteans", "MT, ranged and caster each bait one tornado. Its first wave is marked: step out of it, then step back in for the unmarked one. MT takes both bosses' cleaves; OT stays to the side.",
     # M1/M2 moved ~1 square north of the plan (10.18/10.13 -> 9.0) so MT, not M2, is
     # closest to the south tornado, as the plan's drawing intends.
     P((3.5,12.88), (3.1,11.8), (6.9,3.85), (11.13,11), (5.05,9.0), (6.1,9.0), (11.73,4.3), (3.08,4.3))),
    (38, "Doll spawns", "Dolls appear just counter-clockwise of each cardinal. Stand on your doll so you're never in two Exhausts.",
     P((4.18,13.63), (3.1,11.8), (5.88,4.35), (11.13,11), (5.63,8.15), (8.93,9.32), (12.45,4.2), (2.05,4.22))),
    (49, "First feeds", "Melee feed their dolls to Living Liquid. Orbs (Embolus) appear from the side tornadoes: don't touch them. Ranged drag dolls out and come in for heals.",
     P((6.83,8.4), (6.43,8), (7.53,7.5), (7.5,6.73), (4.43,9.85), (5.38,10.43), (10.33,5.33), (5,5.13))),
    (55, "Bosses center + split tank busters", "Bosses meet in the middle. MT points Living Liquid south-east, OT points the Hand south-west; everyone else stays out of both cleaves.",
     P((8.28,8.07), (6.73,8.1), (6.8,4.9), (7.93,5.15), (6.98,6.28), (7.88,6.2), (10.33,5.33), (5,5.13))),
    (61, "Last feeds", "Ranged and caster feed the last two dolls. Then line up: tanks south, everyone else north.",
     P((8.28,8.07), (6.73,8.1), (6.8,4.9), (7.93,5.15), (6.98,6.28), (7.88,6.2), (6.55,6.85), (8.18,7.03))),
    (66, "Protean Wave 1: bait north/south", "Everyone bunches north of the boss, tanks south, so the marked waves aim north and south. Step out of the lines before they fire. Never stand straight in front of the boss.",
     P((7.48,8.38), (7.45,9.07), (7.68,6.18), (7.75,6.23), (7.55,6.28), (7.58,6.4), (7.3,6.7), (7.58,6.85))),
    (71, "Protean Wave 1: melee take it", "Tanks and melee stay close to take the follow-up waves; ranged and healers spread out in pairs to bait Sluice.",
     P((8.43,8.38), (6.6,8.32), (5.63,4.5), (9.45,4.78), (6.45,7.28), (8.65,7.4), (9.98,5.28), (5.55,5.05))),
    (74, "Protean Wave 1: ranged take it", "Melee back out to max melee; ranged and healers come in close to take the next waves.",
     P((8.82,8.9), (6.13,8.9), (6.6,6.28), (8.57,6.33), (5.83,9.25), (9.2,9.43), (8.9,7.33), (6.15,7.33))),
    (85, "Splash + Drainage", "Melee go north so they don't steal the tanks' tethers. Tanks stand apart so their Drainage circles don't overlap.",
     P((9.05,8.9), (6,8.93), (7.18,5.65), (7.98,5.95), (6.7,5.85), (8.23,5.93), (8.07,5.28), (7.48,5.48))),
    (91, "Cascade 2", "Tornadoes vanish during the cast. Shield up and be ready for the new north.",
     P((8.05,8.6), (7.18,8.73), (7.18,5.65), (7.98,5.95), (6.7,5.85), (8.23,5.93), (8.07,5.28), (7.48,5.48))),
    (103, "Tornadoes return + cleanses", "Six players get a debuff to cleanse. Line up for Protean Wave 2: tanks, regen healer and caster north, everyone else south.",
     P((7.4,4.93), (7.5,6), (7.43,5.63), (7.53,9.7), (7.35,8.1), (7.53,10.3), (7.45,9.3), (7.45,4.3))),
    (106, "Protean Wave 2: dodge north/south", "Step out of the north and south lines.",
     P((8.4,6.15), (6.28,7.38), (3.73,3.8), (4.05,12.45), (6.85,8.68), (8.68,7.43), (11.95,10.43), (3.28,4.4))),
    (108, "Protean Wave 2: melee take it", "M1 steps back in on the south side; melee take the unmarked waves. Ranged bait Sluice and the marked tornado waves at the edges, then dodge them.",
     P((8.4,6.15), (6.28,7.38), (3.73,3.8), (4.05,12.45), (7.48,8.73), (8.68,7.43), (11.95,10.43), (3.28,4.4))),
    (111, "Protean Wave 2: ranged take it", "Ranged and healers come in; OT, M1 and M2 start heading for the tornadoes.",
     P((9.38,5.4), (4.6,9.48), (6.75,6.28), (7.58,8.38), (9.82,9.73), (9.05,5.85), (8.7,7.38), (6.25,7.25))),
    (114, "Melee bait tornadoes", "OT, M1 and M2 each bait one tornado. MT pulls Living Liquid north-east, away from the Hand.",
     P((9.85,4.97), (2.65,10.75), (6.75,6.28), (7.58,8.38), (11.08,12), (11.33,4.65), (8.7,7.38), (6.25,7.25))),
    (123, "Hand of Parting", "The bosses were apart when the cast started, so bring them together. A second pair of orbs drifts toward where the bosses stood: keep clear.",
     P((9.85,4.97), (9.45,4.63), (6.75,6.28), (7.58,8.38), (8.63,6.7), (9.28,6.23), (8.5,7.83), (6.25,7.25))),
]

LOOP = 130  # 2:10. The plan ends after Hand of Parting; most groups kill Living Liquid by then.
strategy = {
    "id": "living-liquid-apt",
    "name": "APT (Elina)",
    "source": {"title": "Living Liquid APT", "author": "Elina", "url": "https://ff14.toolboxgaming.space/?id=725383877116761&preview=1"},
    "default": steps[0][3],
    "positions": {},
    "steps": [{"at": at, "label": label, "note": note, "positions": pos} for at, label, note, pos in steps],
}

def key(at, **kw):
    return {"at": at, **kw}

tornado_keys = [key(0, visible=False), key(18, visible=True), key(87, visible=False), key(93, visible=True)]
actors = [
    # Living Liquid faces south (its tanks) for Protean Wave 1 and north for
    # Protean Wave 2, matching the "wave in front of the boss" in the plan.
    {"id": "liquid", "name": "Living Liquid", "kind": "boss", "radius": g(1.55), "keys": [
        key(0, **W(7.4, 7.33), facing=0),
        key(28, **W(4.35, 12.13), move=8, facing=200),
        key(44, **W(5.8, 9.55), move=5),
        key(53, **W(7.58, 7.45), move=6, facing=135),
        key(63, facing=180),
        key(95, facing=0),
        key(116, **W(8.95, 5.73), move=5, facing=45),
    ]},
    {"id": "hand", "name": "Liquid Hand", "kind": "boss", "radius": g(0.98), "keys": [
        key(0, **W(7.4, 7.88), facing=0),
        key(28, **W(8.65, 5.98), move=8),
        key(35, **W(4.6, 11.6), move=4, facing=204),
        key(44, **W(5.75, 9.65), move=5),
        key(53, **W(7.43, 7.38), move=6, facing=225),
        key(116, **W(3.93, 10.23), move=5, facing=235),
        key(123, **W(8.13, 6.2), move=4, facing=58),
    ]},
    {"id": "rage-w", "name": "Liquid Rage (W)", "kind": "object", "look": "tornado", "radius": g(1.2), "keys": [key(0, **W(1.88, 7.44)), *tornado_keys]},
    {"id": "rage-e", "name": "Liquid Rage (E)", "kind": "object", "look": "tornado", "radius": g(1.2), "keys": [key(0, **W(12.99, 7.32)), *tornado_keys]},
    {"id": "rage-s", "name": "Liquid Rage (S)", "kind": "object", "look": "tornado", "radius": g(1.2), "keys": [key(0, **W(7.49, 13.08)), *tornado_keys]},
    # Jagd Dolls spawn at 0:35; melee dolls are fed after the first Exhaust, ranged ones after the second.
    {"id": "doll1", "name": "D1", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(5.13, 7.63)), key(35, visible=True), key(44, **W(4.78, 8.35), move=5), key(47, visible=False)]},
    {"id": "doll2", "name": "D2", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(7.75, 8.78)), key(35, visible=True), key(44, **W(5.78, 9.1), move=5), key(47, visible=False)]},
    {"id": "doll3", "name": "D3", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(8.9, 6.05)), key(35, visible=True), key(44, **W(11.03, 3.98), move=5), key(60, **W(6.83, 6.6), move=5), key(62, visible=False)]},
    {"id": "doll4", "name": "D4", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(6.23, 5.1)), key(35, visible=True), key(44, **W(3.1, 3.95), move=5), key(60, **W(6.95, 6.68), move=5), key(62, visible=False)]},
    # Embolus (0:40): two orbs leave the side tornadoes and drift slowly (path from the plan).
    {"id": "orb1", "name": "Embolus", "kind": "object", "look": "orb", "radius": g(0.4), "keys": [key(0, visible=False, **W(1.65, 7.35)), key(40, visible=True), key(55, **W(3.28, 10.77), move=15), key(63, **W(5.55, 14.45), move=8), key(66, visible=False)]},
    {"id": "orb2", "name": "Embolus", "kind": "object", "look": "orb", "radius": g(0.4), "keys": [key(0, visible=False, **W(13.05, 7.33)), key(40, visible=True), key(55, **W(10.2, 10.2), move=15), key(63, **W(5.65, 12.8), move=8), key(66, visible=False)]},
    # Embolus (1:58): toward where the bosses stood when they spawned, at about the same slow speed.
    {"id": "orb3", "name": "Embolus", "kind": "object", "look": "orb", "radius": g(0.4), "keys": [key(0, visible=False, **W(1.88, 7.44)), key(118, visible=True), key(132, **W(3.93, 10.23), move=14)]},
    {"id": "orb4", "name": "Embolus", "kind": "object", "look": "orb", "radius": g(0.4), "keys": [key(0, visible=False, **W(12.99, 7.32)), key(118, visible=True), key(135, **W(8.95, 5.73), move=17)]},
]

A = lambda i: {"kind": "actor", "id": i}
T = lambda s: {"kind": "slot", "slot": s}
PROTEAN_R, PROTEAN_ANGLE = g(8.7), 15
RAGES = ["rage-w", "rage-e", "rage-s"]
def rage_proteans(at, cast, visible):
    name = "Liquid Rage: Protean Wave" + ("" if visible else " (unmarked)")
    return [{"at": at, "cast": cast, "minor": i > 0 or not visible, "mechanic": {"type": "protean", "name": name, "from": A(r), "count": 1, "radius": g(8.05), "angleDeg": 17, "telegraphed": visible}}
            for i, r in enumerate(RAGES)]
def liquid_proteans(at, cast, visible):
    name = "Protean Wave" + ("" if visible else " (unmarked)")
    return {"at": at, "cast": cast, "minor": not visible, "mechanic": {"type": "protean", "name": name, "from": A("liquid"), "count": 4, "radius": PROTEAN_R, "angleDeg": PROTEAN_ANGLE, "telegraphed": visible, "front": True}}
def exhaust(at, minor=False):
    return [{"at": at - 0.5, "cast": 0.5, "minor": minor or i > 0, "mechanic": {"type": "circle", "name": "Exhaust", "at": A(d), "radius": g(1.5), "follow": True, "allowedHits": 1}}
            for i, d in enumerate(["doll1", "doll2", "doll3", "doll4"])]
def sluice(at):
    return {"at": at - 0.5, "cast": 0.5, "minor": True, "mechanic": {"type": "baited", "name": "Sluice", "from": A("liquid"), "pick": "farthest", "count": 4, "radius": g(1.24)}}
def cleave(at, name, frm, slot, minor=False):
    return {"at": at - 0.5, "cast": 0.5, "minor": minor, "mechanic": {"type": "cleave", "name": name, "from": A(frm), "target": T(slot), "radius": g(3.5), "angleDeg": 60}}
def raid(at, cast, name, minor=False):
    return {"at": at, "cast": cast, "minor": minor, "mechanic": {"type": "raidwide", "name": name}}
def embolus(at, orb, until):
    return {"at": at, "cast": until - at, "minor": True, "mechanic": {"type": "zone", "name": "Embolus", "at": A(orb), "radius": g(0.6)}}

# Times follow the Living Liquid timeline in Lyra's guide. Instant casts get a 0.5 s bar.
timeline = [
    cleave(10, "Fluid Swing", "liquid", "MT", minor=True),
    raid(14, 4, "Cascade"),
    raid(30, 5, "Hand of Parting / Prayer"),
    *rage_proteans(32, 3, visible=True),
    cleave(37, "Fluid Swing", "liquid", "MT", minor=True),
    cleave(37, "Fluid Strike", "hand", "MT", minor=True),
    *rage_proteans(37.5, 0.5, visible=False),
    *exhaust(39),
    raid(39, 3, "Hand of Pain", minor=True),
    embolus(40, "orb1", 66), embolus(40, "orb2", 66),
    *exhaust(49, minor=True),
    cleave(55, "Fluid Swing", "liquid", "MT"),
    cleave(55, "Fluid Strike", "hand", "OT", minor=True),
    liquid_proteans(66, 3, visible=True),
    raid(66, 3, "Hand of Pain", minor=True),
    sluice(71),
    liquid_proteans(70.5, 0.5, visible=False),
    liquid_proteans(73.5, 0.5, visible=False),
    raid(79.5, 0.5, "Splash ×6"),
    {"at": 81, "cast": 4, "mechanic": {"type": "spread", "name": "Drainage", "on": ["MT", "OT"], "radius": g(1.3)}},
    raid(87, 4, "Cascade"),
    raid(94.5, 0.5, "Throttle"),
    liquid_proteans(103, 3, visible=True),
    raid(105, 3, "Hand of Pain", minor=True),
    liquid_proteans(107.5, 0.5, visible=False),
    *[dict(e, minor=True) for e in rage_proteans(108, 3, visible=True)],
    sluice(108),
    liquid_proteans(110.5, 0.5, visible=False),
    *rage_proteans(113.5, 0.5, visible=False),
    embolus(118, "orb3", 130), embolus(118, "orb4", 130),
    raid(119, 4, "Hand of Parting / Prayer"),
    raid(125, 3, "Hand of Pain", minor=True),
    raid(126.5, 0.5, "Splash ×6", minor=True),
]
timeline.sort(key=lambda e: e["at"])

encounter = {
    "id": "tea-living-liquid",
    "name": "TEA: Living Liquid",
    "arenaRadius": 20,
    "bossRadius": g(1.55),
    "loopLength": LOOP,
    "source": {
        "title": "Living Liquid APT",
        "author": "Elina",
        "url": "https://ff14.toolboxgaming.space/?id=725383877116761&preview=1",
        "caveat": "AoE sizes are scaled from the plan's drawings and may be off.",
    },
    "moreSources": [{"title": "Lyra's TEA guide", "url": "https://docs.google.com/document/d/1wKE4Hj7asv5PsJT4w4mL5chDRMTtgUbdPCsJWqGsuJk/edit", "usedFor": "cast timeline and mechanic rules"}],
    "actors": actors,
    "timeline": timeline,
}

root = pathlib.Path(__file__).resolve().parent.parent / "src" / "data"
(root / "encounters" / "tea-living-liquid.json").write_text(json.dumps(encounter, indent=1) + "\n")
(root / "strategies" / "tea-living-liquid-apt.json").write_text(json.dumps(strategy, indent=1) + "\n")
print("timeline entries:", len(timeline), "steps:", len(steps))
