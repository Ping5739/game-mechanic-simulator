"""
Builds the Living Liquid encounter + "APT" strategy JSON from positions taken
from Elina's Toolbox Gaming plan (https://ff14.toolboxgaming.space/?id=725383877116761).

The plan is a 15x15 grid of snapshots with no timings. Positions are converted
to world units (arena radius 20); timings, AoE sizes and hit rules are
approximations chosen to match the plan's order and drawings.

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
    (4,   "Cascade", "Tornadoes appear west, east and south; the open side counts as north. Stack in the middle.",
     P((7.4,6), (7.43,8.73), (8.73,9.18), (6.1,8.98), (6.38,8.05), (8.55,7.95), (6.9,9.3), (7.93,9.35))),
    (14,  "Split bosses", "MT drags Living Liquid south-west by the south tornado; OT takes the Hand the other way. Caster heads to bait the west tornado, ranged the east one.",
     P((3.98,13.48), (9.13,5.2), (6.9,3.85), (11.13,11), (7.5,6.83), (8.23,7.48), (12.58,4), (2.85,4.2))),
    (20,  "Tornado proteans", "MT takes the Hand (with a cooldown); OT stays to the side of the cleave. MT, ranged and caster each bait one tornado's protean.",
     P((3.5,12.88), (3.1,11.8), (6.9,3.85), (11.13,11), (5.05,10.18), (6.1,10.13), (11.73,4.3), (3.08,4.3))),
    (30,  "Doll spawns", "Dolls appear just counter-clockwise of each cardinal. Stand on your doll so you're never in two Exhausts.",
     P((4.18,13.63), (3.1,11.8), (5.88,4.35), (11.13,11), (5.63,8.15), (8.93,9.32), (12.45,4.2), (2.05,4.22))),
    (40,  "First feeds", "Melee feed their dolls to Living Liquid. Orbs (Embolus) appear from the side tornadoes: don't touch them. Ranged drag dolls out and come in for heals.",
     P((6.83,8.4), (6.43,8), (7.53,7.5), (7.5,6.73), (4.43,9.85), (5.38,10.43), (10.33,5.33), (5,5.13))),
    (50,  "Bosses center + split tank busters", "Bosses meet in the middle. MT points Living Liquid south-east, OT points the Hand south-west; everyone else stays out of both cleaves.",
     P((8.28,8.07), (6.73,8.1), (6.8,4.9), (7.93,5.15), (6.98,6.28), (7.88,6.2), (10.33,5.33), (5,5.13))),
    (58,  "Last feeds", "Ranged and caster feed the last two dolls. Then line up: tanks south, everyone else north.",
     P((8.28,8.07), (6.73,8.1), (6.8,4.9), (7.93,5.15), (6.98,6.28), (7.88,6.2), (6.55,6.85), (8.18,7.03))),
    (63,  "Protean Wave 1: bait north/south", "Everyone bunches north of the boss, tanks south, so the telegraphed waves go north and south. Then step out of the lines.",
     P((7.48,8.38), (7.45,9.07), (7.68,6.18), (7.75,6.23), (7.55,6.28), (7.58,6.4), (7.3,6.7), (7.58,6.85))),
    (67,  "Protean Wave 1: melee take it", "Tanks and melee stay close to take the follow-up waves; ranged and healers spread out in pairs to bait Sluice.",
     P((8.43,8.38), (6.6,8.32), (5.63,4.5), (9.45,4.78), (6.45,7.28), (8.65,7.4), (9.98,5.28), (5.55,5.05))),
    (70,  "Protean Wave 1: ranged take it", "Melee back out to max melee; ranged and healers come in close to take the next waves.",
     P((8.82,8.9), (6.13,8.9), (6.6,6.28), (8.57,6.33), (5.83,9.25), (9.2,9.43), (8.9,7.33), (6.15,7.33))),
    (78,  "Splash + Drainage", "Melee go north so they don't steal the tanks' tethers. Tanks stand apart so their Drainage circles don't overlap.",
     P((9.05,8.9), (6,8.93), (7.18,5.65), (7.98,5.95), (6.7,5.85), (8.23,5.93), (8.07,5.28), (7.48,5.48))),
    (86,  "Cascade 2", "Tornadoes vanish during the cast. Shield up and be ready for the new north.",
     P((8.05,8.6), (7.18,8.73), (7.18,5.65), (7.98,5.95), (6.7,5.85), (8.23,5.93), (8.07,5.28), (7.48,5.48))),
    (94,  "Tornadoes return + cleanses", "Six players get a debuff to cleanse. Line up for Protean Wave 2: tanks, regen healer and caster north, everyone else south.",
     P((7.4,4.93), (7.5,6), (7.43,5.63), (7.53,9.7), (7.35,8.1), (7.53,10.3), (7.45,9.3), (7.45,4.3))),
    (99,  "Protean Wave 2: dodge north/south", "Step out of the north and south lines.",
     P((8.4,6.15), (6.28,7.38), (3.73,3.8), (4.05,12.45), (6.85,8.68), (8.68,7.43), (11.95,10.43), (3.28,4.4))),
    (102, "Protean Wave 2: melee take it", "M1 steps back in on the south side; melee take the waves while ranged bait Sluice at the edges.",
     P((8.4,6.15), (6.28,7.38), (3.73,3.8), (4.05,12.45), (7.48,8.73), (8.68,7.43), (11.95,10.43), (3.28,4.4))),
    (105, "Protean Wave 2: ranged take it", "Ranged and healers come in; OT, M1 and M2 start heading for the tornadoes.",
     P((9.38,5.4), (4.6,9.48), (6.75,6.28), (7.58,8.38), (9.82,9.73), (9.05,5.85), (8.7,7.38), (6.25,7.25))),
    (112, "Melee bait tornadoes", "OT, M1 and M2 each bait one tornado. MT pulls Living Liquid north-east, away from the Hand.",
     P((9.85,4.97), (2.65,10.75), (6.75,6.28), (7.58,8.38), (11.08,12), (11.33,4.65), (8.7,7.38), (6.25,7.25))),
    (122, "Hand of Parting", "Bring the bosses back together. Watch for orbs.",
     P((9.85,4.97), (9.45,4.63), (6.75,6.28), (7.58,8.38), (8.63,6.7), (9.28,6.23), (8.5,7.83), (6.25,7.25))),
]

LOOP = 128
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

tornado_keys = [key(0, visible=False), key(4, visible=True), key(82, visible=False), key(92, visible=True)]
actors = [
    {"id": "liquid", "name": "Living Liquid", "kind": "boss", "radius": g(1.55), "keys": [
        key(0, **W(7.4, 7.33), facing=180),
        key(13, **W(4.35, 12.13), move=7),
        key(39, **W(5.8, 9.55), move=5),
        key(48, **W(7.58, 7.45), move=4, facing=135),
        key(60, facing=0),
        key(92, facing=180),
        key(111, **W(8.95, 5.73), move=5, facing=45),
    ]},
    {"id": "hand", "name": "Liquid Hand", "kind": "boss", "radius": g(0.98), "keys": [
        key(0, **W(7.4, 7.88), facing=0),
        key(13, **W(8.65, 5.98), move=7),
        key(18, **W(4.6, 11.6), move=4, facing=204),
        key(39, **W(5.75, 9.65), move=5),
        key(48, **W(7.43, 7.38), move=4, facing=225),
        key(111, **W(3.93, 10.23), move=5, facing=235),
        key(120, **W(8.13, 6.2), move=6, facing=58),
    ]},
    {"id": "rage-w", "name": "Liquid Rage (W)", "kind": "object", "look": "tornado", "radius": g(1.2), "keys": [key(0, **W(1.88, 7.44)), *tornado_keys]},
    {"id": "rage-e", "name": "Liquid Rage (E)", "kind": "object", "look": "tornado", "radius": g(1.2), "keys": [key(0, **W(12.99, 7.32)), *tornado_keys]},
    {"id": "rage-s", "name": "Liquid Rage (S)", "kind": "object", "look": "tornado", "radius": g(1.2), "keys": [key(0, **W(7.49, 13.08)), *tornado_keys]},
    # Jagd Dolls: fed (vanish) after their feed steps.
    {"id": "doll1", "name": "D1", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(5.13, 7.63)), key(26, visible=True), key(39, **W(4.78, 8.35), move=5), key(46, visible=False)]},
    {"id": "doll2", "name": "D2", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(7.75, 8.78)), key(26, visible=True), key(39, **W(5.78, 9.1), move=5), key(46, visible=False)]},
    {"id": "doll3", "name": "D3", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(8.9, 6.05)), key(26, visible=True), key(39, **W(11.03, 3.98), move=5), key(57, **W(6.83, 6.6), move=5), key(60, visible=False)]},
    {"id": "doll4", "name": "D4", "kind": "add", "radius": g(0.5), "keys": [key(0, visible=False, **W(6.23, 5.1)), key(26, visible=True), key(39, **W(3.1, 3.95), move=5), key(57, **W(6.95, 6.68), move=5), key(60, visible=False)]},
    # Embolus orbs drift out of the side tornadoes.
    {"id": "orb1", "name": "Embolus", "kind": "object", "look": "orb", "radius": g(0.4), "keys": [key(0, visible=False, **W(1.65, 7.35)), key(38, visible=True), key(50, **W(3.28, 10.77), move=12), key(58, **W(5.55, 14.45), move=8), key(64, visible=False)]},
    {"id": "orb2", "name": "Embolus", "kind": "object", "look": "orb", "radius": g(0.4), "keys": [key(0, visible=False, **W(13.05, 7.33)), key(38, visible=True), key(50, **W(10.2, 10.2), move=12), key(58, **W(5.65, 12.8), move=8), key(64, visible=False)]},
]

A = lambda i: {"kind": "actor", "id": i}
T = lambda s: {"kind": "slot", "slot": s}
PROTEAN_R, PROTEAN_ANGLE = g(8.7), 15
def rage_proteans(at, cast, name="Protean Wave (tornado)", minor=False):
    return [{"at": at, "cast": cast, "minor": minor or i > 0, "mechanic": {"type": "protean", "name": name, "from": A(r), "count": 1, "radius": g(8.05), "angleDeg": 17}}
            for i, r in enumerate(["rage-w", "rage-e", "rage-s"])]
def liquid_proteans(at, cast, name):
    return {"at": at, "cast": cast, "minor": True, "mechanic": {"type": "protean", "name": name, "from": A("liquid"), "count": 4, "radius": PROTEAN_R, "angleDeg": PROTEAN_ANGLE}}
def telegraphed_ns(at, cast, name, minor=False):
    return [{"at": at, "cast": cast, "minor": minor or i > 0, "mechanic": {"type": "cone", "name": name, "from": A("liquid"), "radius": PROTEAN_R, "angleDeg": PROTEAN_ANGLE, "facingDeg": d}}
            for i, d in enumerate([0, 180])]
def exhaust(at, cast, dolls, minor=False):
    return [{"at": at, "cast": cast, "minor": minor or i > 0, "mechanic": {"type": "circle", "name": "Exhaust", "at": A(d), "radius": g(1.5), "follow": True, "allowedHits": 1}}
            for i, d in enumerate(dolls)]
def sluice(at, cast):
    return {"at": at, "cast": cast, "minor": True, "mechanic": {"type": "baited", "name": "Sluice", "from": A("liquid"), "pick": "farthest", "count": 4, "radius": g(1.24)}}
def cleave(at, cast, name, frm, slot, minor=False):
    return {"at": at, "cast": cast, "minor": minor, "mechanic": {"type": "cleave", "name": name, "from": A(frm), "target": T(slot), "radius": g(3.5), "angleDeg": 60}}

timeline = [
    {"at": 0, "cast": 4, "mechanic": {"type": "raidwide", "name": "Cascade"}},
    *rage_proteans(16, 4),
    cleave(17, 3, "Fluid Strike", "hand", "MT", minor=True),
    *rage_proteans(26, 4, minor=True),
    *exhaust(30, 4, ["doll1", "doll2", "doll3", "doll4"]),
    {"at": 38, "cast": 26, "minor": True, "mechanic": {"type": "zone", "name": "Embolus", "at": A("orb1"), "radius": g(0.6)}},
    {"at": 38, "cast": 26, "minor": True, "mechanic": {"type": "zone", "name": "Embolus", "at": A("orb2"), "radius": g(0.6)}},
    *exhaust(40, 4, ["doll1", "doll2", "doll3", "doll4"], minor=True),
    cleave(47, 3, "Fluid Swing", "liquid", "MT"),
    cleave(47, 3, "Fluid Strike", "hand", "OT", minor=True),
    *telegraphed_ns(63, 4, "Protean Wave"),
    liquid_proteans(64, 3, "Protean Wave (close)"),
    sluice(64, 3),
    liquid_proteans(67, 3, "Protean Wave (close)"),
    {"at": 72, "cast": 3, "mechanic": {"type": "raidwide", "name": "Splash"}},
    {"at": 74, "cast": 4, "mechanic": {"type": "spread", "name": "Drainage", "on": ["MT", "OT"], "radius": g(1.3)}},
    {"at": 82, "cast": 4, "mechanic": {"type": "raidwide", "name": "Cascade"}},
    {"at": 90, "cast": 3, "mechanic": {"type": "raidwide", "name": "Throttle"}},
    *telegraphed_ns(95, 4, "Protean Wave"),
    liquid_proteans(99, 3, "Protean Wave (close)"),
    sluice(99, 3),
    liquid_proteans(102, 3, "Protean Wave (close)"),
    *rage_proteans(108, 4),
    {"at": 118, "cast": 4, "mechanic": {"type": "raidwide", "name": "Hand of Parting"}},
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
        "caveat": "Positions follow the strategy plan; timings, AoE sizes and hit rules are approximate.",
    },
    "actors": actors,
    "timeline": timeline,
}

root = pathlib.Path(__file__).resolve().parent.parent / "src" / "data"
(root / "encounters" / "tea-living-liquid.json").write_text(json.dumps(encounter, indent=1) + "\n")
(root / "strategies" / "tea-living-liquid-apt.json").write_text(json.dumps(strategy, indent=1) + "\n")
print("timeline entries:", len(timeline), "steps:", len(steps))
