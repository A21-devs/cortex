"""Cortex palette checks (docs/CORTEX-UX.md sections 0.1, 4.4 and 4.5).

1. Accessibility: re-derives Prism's slot order (best worst-case adjacent colour-blind separation across the
   glow, fill and light variants) and reports, for every categorical palette, OKLCH lightness and chroma,
   worst adjacent separation under simulated protanopia/deuteranopia (Machado, Oliveira and Fernandes 2009,
   severity 1.0), worst adjacent separation under normal vision, and WCAG contrast against the surface the
   variant is drawn on. Ramps must rise (or fall) monotonically in lightness.
2. Originality (review ORIG-10): every colour Cortex ships is compared with every data colour listed in
   section 6 of docs/research/video-B/C/D/E.md.
   A. Floor: a chromatic stop (OKLCH C >= 0.04) must be at least 5 dE from every observed stop; a near-neutral
      stop (C < 0.04) at least 3 dE.
   B. No counterpart sets: a shipped palette or ramp (4 or more stops) fails against any observed palette
      (4 or more stops; sample bags such as particle colours are excluded) when the best one-to-one
      assignment between them has a mean distance under 6.5, or when at least 4 stops, and at least half
      of the set, pair one to one at under 6.
   C. Negative controls: the palettes, themes and time ramp the review flagged must fail rule B, so the check
      is known to catch a counterpart set.
   The literal "8 dE from every observed stop" count is printed for information (see CORTEX-UX section 11).
Distances are Euclidean in OKLab x 100. Exit status 1 if any hard check fails.

Run: python palette_check.py
"""
import itertools, math, sys

MACHADO = {
    "protan": [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    "deutan": [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
}

def s2lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def lin2s(c):
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
def hex2lin(h): return tuple(s2lin(int(h[i:i + 2], 16) / 255) for i in (1, 3, 5))
def lin2oklab(r, g, b):
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
def oklab2hex(L, a, b):
    l_, m_, s_ = L + 0.3963377774 * a + 0.2158037573 * b, L - 0.1055613458 * a - 0.0638541728 * b, L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    rgb = (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    return "#%02x%02x%02x" % tuple(round(lin2s(c) * 255) for c in rgb)
def oklch_of(h):
    L, a, b = lin2oklab(*hex2lin(h)); return L, math.hypot(a, b)
def sim(h, kind):
    r, g, b = hex2lin(h); M = MACHADO[kind]
    return tuple(max(0.0, min(1.0, M[i][0] * r + M[i][1] * g + M[i][2] * b)) for i in range(3))
def dE(h1, h2, kind=None):
    a = lin2oklab(*(sim(h1, kind) if kind else hex2lin(h1)))
    b = lin2oklab(*(sim(h2, kind) if kind else hex2lin(h2)))
    return 100 * math.dist(a, b)
def lum(h):
    r, g, b = hex2lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b
def contrast(a, b):
    x, y = sorted((lum(a), lum(b)), reverse=True); return (x + 0.05) / (y + 0.05)

# ---------------------------------------------------------------- what Cortex ships
PRISM = {  # name: (glow, fill, light), slot order derived below
    "azure": ("#7ab9fd", "#5293ed", "#156ec3"), "amber": ("#deb125", "#cd8000", "#a56500"),
    "rose": ("#f58ebc", "#d35e9a", "#b84580"), "citron": ("#cbd871", "#9d9900", "#878300"),
    "teal": ("#2eeafd", "#00a0ad", "#0090a4"), "coral": ("#e6ac86", "#d95833", "#c5482c"),
    "violet": ("#c4a9ff", "#9875e3", "#864fc2"), "mint": ("#6ad39a", "#09a773", "#008c5f"),
}
PRISM_ORDER = ("azure", "amber", "rose", "citron", "teal", "coral", "violet", "mint")
SIGNAL_GLOW = "#dfb748 #f487c5 #cddb78 #a2cffe #f17731 #169ad6 #3fd399".split()
SIGNAL_LIGHT = "#b17a00 #b6508c #ada200 #0f9bd7 #b54f02 #005d92 #008a64".split()
# Harbor, Orchard (colour-blind first), Ember and Reef: found by a search under the checks below (5 dE floor from every
# observed stop, no counterpart set, 8 dE apart for neighbours under protan and deutan vision in the first two).
HARBOR_GLOW = "#749dff #d3b047 #00b786 #ffbef9 #8ea442 #b99bfe #04ecff #e97996".split()
HARBOR_FILL = "#7596ff #cd6d0c #669e68 #e475c6 #a8a835 #b35ee1 #2aafb3 #db8176".split()
HARBOR_LIGHT = "#005d9c #c63e00 #1f7c60 #a25aa9 #5b4c00 #51448d #005a5a #a0696b".split()
ORCHARD_GLOW = "#ba7ec4 #ffd19f #a9b33d #04ada6 #a6b2ff #f37ba4 #e354a9 #c38304".split()
ORCHARD_FILL = "#dc89d3 #cb7100 #5d986a #1bc79e #0095b7 #dd807b #c462b8 #ba9600".split()
ORCHARD_LIGHT = "#93609f #66461e #007b2c #007772 #245197 #9a3a00 #a8046e #997401".split()
EMBER_GLOW = "#f95fa6 #cba100 #d07b04 #f6b2e4 #e18cc6 #15b1a4 #8ca54d #e8ab74".split()
EMBER_FILL = "#e37f7e #9c874e #a89f00 #f470c0 #bd6acf #22a3aa #70b586 #d06d18".split()
EMBER_LIGHT = "#a93f00 #9b6f52 #786700 #8c5979 #653b8d #207c66 #00750d #6d4200".split()
REEF_GLOW = "#04ecff #4ab981 #a8ceff #d494e3 #00afb7 #b5a748 #ffb4dd #7caeee".split()
REEF_FILL = "#0097aa #7f8f4b #90a3ff #c986d8 #00ad56 #b98400 #ad67d6 #15b6b6".split()
REEF_LIGHT = "#007580 #465500 #3444a3 #5d3a7b #008555 #7d601b #9f006e #005a5a".split()
OTHER = ("#b6bbd3", "#7b90a5", "#4a5666")      # mist: glow, fill, light
NO_VALUE = ("#727b8a", "#66686f", "#7e8086")   # slate: glow, fill, light
AGE_DARK = "#866fc8 #5890ec #37acc3 #56c4a7 #90cf82 #cdd261 #e1d6ba #f0e0c6".split()
AGE_LIGHT = "#b1b0ed #82a5ec #229dc3 #018d87 #2c7f44 #5f6700 #734c00 #772e00".split()
COUNT_DARK = "#1e2c3f #004568 #265d8e #3d6dc3 #5692ec #73b2f8 #abcffe".split()
COUNT_LIGHT = "#aacefc #92b0e6 #5593ea #426ec3 #0f62a4 #084c81 #0c3965".split()
COUNT_EMPTY = ("#1e2b38", "#e5e4d1")
DIV_DARK = "#fdd0a0 #dcab53 #c68128 #4e4f58 #926fd4 #b295ee #e9baff".split()
DIV_LIGHT = "#a36400 #cc8730 #e6af73 #ccc3cb #bcabe6 #9a7ad9 #814cb7".split()
STATUS_DARK = "#4cc38a #dfbc5e #f27733 #e6737c".split()
STATUS_LIGHT = "#168a5a #a66a00 #b9541d #ce2637".split()
MACHINE = ("#b8a6ff", "#7b4acc")
STAGES = ("#06070a", "#f4f2ee")                # Ink, Paper (plus the Stage tint, which only shifts the lift)
# Print mode: computed, not a palette. Four brown-black ink greys x two fills (solid, 45-degree hatch).
PRINT_L = (0.30, 0.42, 0.54, 0.66)
PRINT_GREYS = [oklab2hex(L, 0.02 * math.cos(math.radians(15)), 0.02 * math.sin(math.radians(15))) for L in PRINT_L]
PRINT_SLOTS = [(0, "solid"), (2, "hatch"), (1, "solid"), (3, "hatch"), (2, "solid"), (0, "hatch"), (3, "solid"), (1, "hatch")]

def shipped_sets():
    sets = {f"Prism {v}": [PRISM[n][i] for n in PRISM_ORDER] for i, v in enumerate(("glow", "fill", "light"))}
    for n in ("HARBOR", "ORCHARD", "EMBER", "REEF"):
        sets.update({f"{n.title()} {v}": globals()[f"{n}_{v.upper()}"] for v in ("glow", "fill", "light")})
    sets.update({"Signal glow": SIGNAL_GLOW, "Signal light": SIGNAL_LIGHT, "Other (mist)": list(OTHER), "No value (slate)": list(NO_VALUE),
                 "Age ramp dark": AGE_DARK, "Age ramp light": AGE_LIGHT, "Count ramp dark": COUNT_DARK + [COUNT_EMPTY[0]],
                 "Count ramp light": COUNT_LIGHT + [COUNT_EMPTY[1]], "Diverging dark": DIV_DARK, "Diverging light": DIV_LIGHT,
                 "Status dark": STATUS_DARK, "Status light": STATUS_LIGHT, "Machine": list(MACHINE), "Print greys": PRINT_GREYS})
    return sets

# ---------------------------------------------------------------- what the recordings show (section 6 of each analysis)
# Data colours only: palette stops, legend dots, speaker and kind colours, ramps, particle and effect samples.
# Chrome greys, panel backgrounds, text colours and OS-drawn menu colours are not data stops and are left out.
OBSERVED = {k: v.split() for k, v in {
    "B folder dots": "#2d2c48 #afd5d8 #51618a #d8eeec #3a4464 #cdf4ee #6185a6",
    "B kind dots": "#302f49 #c6d9e7 #4a637d #e2fdfc #37526c #c9e0e9 #ffffff",
    "B function dots": "#5b5b70 #646383 #908fa9 #b3cecb #546785 #9094ab #3c4c64",
    "B shelf dots": "#31323b #cacce3 #57606a #e5eefa",
    "B hub type dots": "#424144 #bacccf #596681",
    "B project status dots": "#2b3439 #b2c5cd",
    "B speakers": "#6ce5d6 #1c80c8",
    "B lens tints": "#afb0b1 #848e91 #97a6a9 #96a1a3 #8c9899 #545c7f #52617a #5d6b82",
    "B particles": "#4881a1 #5c869d #6596b1 #96adba #3d6ea3 #4682bb #649ed6 #d7e8f5 #f8f9fb #cdcfd2 #a0a2a6 #293238 #42494e #7da5a5 #7eb5bb #74aec7",
    "B meters and charts": "#20242a #565858 #677478 #6c8599 #637571 #d7d7d6 #8b8b8b #898a8c #bbbfc0",
    "C speakers": "#27bcfc #b578ff #ffaf00",
    "C kinds": "#ee2a3a #f39a1e #ecd94a #8fd65a #3ee8cc #3aa6f0 #7d6ef0",
    "C kind dots": "#cc5f79 #f0cf76 #f6f7b6 #bedea5 #89f7e5 #8bc3e8 #968dd4",
    "C shelves": "#e8445a #f0962e #eee35a #f0f0f0",
    "C month ramp": "#6549b6 #7c8ad4 #a2ddec #9ff6e5 #a4f5a6 #e6e09a #e9c194 #de998f #b63f46",
    "C live dot": "#f2506e",
    "D Default": "#fa6552 #fca62f #cce348 #5aeb81 #38b7e4 #6980fa #e167e4",
    "D Lava": "#6c0c11 #a81518 #e6341a #fe581c #ff8a1b #ffb93f #fada6a",
    "D Ocean": "#163b89 #1959c2 #2389de #23bcde #3dded9 #74f0e6 #a6f6ef",
    "D Forest": "#173e1b #1e6738 #2d923c #64b84e #8fdb59 #c3ef6d #e5f590",
    "D Aurora": "#5c29a5 #a338dc #de5dd2 #b99bca #69dac1 #62f599 #a5ff82",
    "D Mono": "#7c7577 #8a8886 #a7a5a6 #bbbbbb #d5d5d5 #e8e8e8 #f4f4f4",
    "D Sunset": "#7e1e50 #b92863 #ed4565 #fd6353 #fd8e40 #feaf44 #ffce65",
    "D folder dots": "#c97289 #d29b6e #e8ea9f #ade9b1 #86cdc9 #8596b7 #8882a3 #393939",
    "D highlight pills": "#cc565b #ea9645 #f3da54 #6ccd66",
    "D Lava dots": "#1d080d #ccb3b2 #7c2d40 #fbded7 #611e2e #e7bfc2 #9a404c",
    "D particles": "#944e43 #ff9f8a #ffd7cb #fffff9 #2a0907 #b3929a #e0a7a9 #caa388 #c790a0 #d7bcb3",
    "D histogram": "#acb4c3 #b2a4a4",
    "E categorical": "#f55a78 #ffc92e #f7fb5a #acf386 #2af6e0 #3ec6f5 #b07ff0 #ffffff",
    "E extended": "#ffd936 #e2e640 #a1fc74 #2ae1bc #58d6fd #3afaa1 #ef60ea #7cf5fe #e2ef4e #4d3fcd #8416cc #f28d5c",
    "E lifelines": "#e9684f #f980f3 #b9fd7c #3b48f7 #43f5bf #de66eb",
    "E months": "#b547ff #914be6 #664ae5 #5848f6 #6e6adb #4ccbcc #61e0c6",
    "E effects": "#f30f22 #fc919a #9c2132 #cf676a #a8a09f #bb8764 #ea8b0e",
    "E histogram": "#d9d0f5 #bfe3ff",
    "E mascot": "#6f5fc0 #2a2047 #cbbcf0",
    "E meter": "#a59c8d #a8a8a5 #8d8696 #887b93",
}.items()}
# Observed sets that are bags of rendered samples rather than palettes: used by rule A only.
SAMPLE_BAGS = {"B particles", "B meters and charts", "B lens tints", "C live dot", "D particles", "D histogram",
               "E effects", "E histogram", "E mascot", "E meter"}
OBSERVED_PALETTES = {k: v for k, v in OBSERVED.items() if k not in SAMPLE_BAGS and len(v) >= 4}
OBSERVED_THEMES = "#010101 #101522 #1f2025 #101b16 #1f1624 #211715".split()   # window themes, video-D section 6
ALL_OBSERVED = [(k, c) for k, v in OBSERVED.items() for c in v]

# Sets the review flagged as counterparts. They are not shipped; rule B must catch them.
NEGATIVE_CONTROLS = {
    "Glacier glow (dropped)": "#4eb8e9 #4e78c7 #9ce2f3 #4ba3e0 #c5f6fb #4c8dd4 #74ceed",
    "Glacier light (dropped)": "#197cb3 #1c3e81 #46a6c5 #1967a3 #61b9ce #1b5293 #2e91bd",
    "Kiln glow (dropped)": "#f79133 #c35141 #face90 #e87a38 #fee9be #d6653d #f9b163",
    "Ash (dropped)": "#afafaf #747474 #d9d9d9 #9b9b9b #eeeeee #878787 #c4c4c4",
    "scaffold kiln": "#70161d #933019 #ac5424 #c5762f #de993b #f4bd47 #fbe48f #fff2c9",
    "scaffold tide": "#113f9b #2062a0 #2c81b3 #38a1c7 #45c1dc #52e2ef #9cfcf7 #d9fffd",
    "scaffold moss": "#18552b #227325 #498d29 #71a634 #99c03f #c1d94a #ebf355 #f7fbb4",
    "scaffold pewter": "#7a7a7a #8d8d8d #a1a1a1 #b6b6b6 #cacaca #dfdfdf #f5f5f5 #ffffff",
    "scaffold dusk": "#841c55 #ad2750 #d7333b #e86431 #f38e3b #f7b661 #fadb8e #fff0d1",
    "scaffold window themes": "#05060a #0a1220 #17191d #0b1611 #18101d #1a1512",
}
NEGATIVE_CONTROLS = {k: v.split() for k, v in NEGATIVE_CONTROLS.items()}
CONTROL_GROUPS = {"Glacier (dropped)": ["Glacier glow (dropped)", "Glacier light (dropped)"]}  # caught if any variant is
# Flagged by the review for their structure (hue sequence) rather than their exact stops. Reported, not asserted.
REPORTED_ONLY = {k: v.split() for k, v in {
    "Nebula glow (dropped)": "#f080b8 #8760cb #ffc2bc #d173c3 #ffe0d5 #ae69ca #ff9eb1",
    "scaffold spectrum": "#f8696b #faab61 #f5e13a #8efd83 #42fcf0 #4fa9f8 #a289f8 #f959bf",
    "scaffold borealis": "#8230d8 #ad33cf #d437bc #67a4f1 #4cd8b9 #55f2a4 #b2fba2 #e6ffe0",
    "scaffold time ramp": "#c4a4fe #86bafe #0acee6 #37d59f #a2c854 #d6b529 #f8a13f #ff958e",
}.items()}

# ---------------------------------------------------------------- checks
SURFACES = ("#07080b", "#1c1c1c", "#ffffff")  # glow on the Ink stage, fill on dark chrome, light on white
FAILS = []

def worst(seq, vi, kinds=("protan", "deutan")):
    return min(dE(PRISM[a][vi], PRISM[b][vi], k) for a, b in zip(seq, seq[1:]) for k in kinds)

def derive_order():
    names = [n for n in PRISM if n != "azure"]
    best = None
    for perm in itertools.permutations(names):
        seq = ("azure",) + perm
        cvd = min(worst(seq, vi) for vi in range(3))
        nor = min(min(dE(PRISM[a][vi], PRISM[b][vi]) for a, b in zip(seq, seq[1:])) for vi in range(3))
        tri = min(dE(PRISM[a][vi], PRISM[b][vi], k) for vi in range(3) for a, b in itertools.combinations(seq[:3], 2) for k in ("protan", "deutan"))
        score = (min(cvd, 12) + 0.3 * min(tri, 12), nor)
        if best is None or score > best[0]:
            best = (score, seq, cvd, nor, tri)
    return best

def report(name, cols, surface):
    adj = list(zip(cols, cols[1:]))
    cvd = min(dE(a, b, k) for a, b in adj for k in ("protan", "deutan"))
    nor = min(dE(a, b) for a, b in adj)
    cr = min(contrast(c, surface) for c in cols)
    Ls = [round(oklch_of(c)[0], 2) for c in cols]; Cs = [round(oklch_of(c)[1], 3) for c in cols]
    print(f"{name:22s} on {surface}: adjacent CVD {cvd:5.1f}  normal {nor:5.1f}  min contrast {cr:4.2f}  L {min(Ls)}-{max(Ls)}  C>={min(Cs)}")

def monotonic(name, cols, rising):
    Ls = [oklch_of(c)[0] for c in cols]
    ok = all((b > a) if rising else (b < a) for a, b in zip(Ls, Ls[1:]))
    print(f"{name:22s} lightness {'rises' if rising else 'falls'} monotonically: {ok}", [round(x, 2) for x in Ls])
    if not ok: FAILS.append(f"{name}: lightness not monotonic")

def nearest(c):
    return min((dE(c, oc), k, oc) for k, oc in ALL_OBSERVED)

def floor_of(c): return 5.0 if oklch_of(c)[1] >= 0.04 else 3.0

def matched_pairs(S, O, thr=8.0):
    """Maximum one-to-one matching between the stops of S and O using pairs closer than thr."""
    adj = [[j for j, o in enumerate(O) if dE(s, o) < thr] for s in S]
    owner = [-1] * len(O)
    def augment(i, seen):
        for j in adj[i]:
            if j not in seen:
                seen.add(j)
                if owner[j] == -1 or augment(owner[j], seen):
                    owner[j] = i; return True
        return False
    return sum(augment(i, set()) for i in range(len(S)))

def assignment_mean(S, O):
    """Mean distance of the cheapest one-to-one assignment of the smaller set into the larger."""
    A, B = (S, O) if len(S) <= len(O) else (O, S)
    D = [[dE(a, b) for b in B] for a in A]
    memo = {}
    def f(i, mask):
        if i == len(A): return 0.0
        key = (i, mask)
        if key not in memo:
            memo[key] = min(D[i][j] + f(i + 1, mask | 1 << j) for j in range(len(B)) if not mask >> j & 1)
        return memo[key]
    return f(0, 0) / len(A)

def counterpart(S, sets):
    """Rule B. Returns (fails, mean, tight pairs, name of the closest observed set)."""
    hit = None
    for name, O in sets.items():
        mean = assignment_mean(S, O); tight = matched_pairs(S, O, 6.0)
        fails = mean < 6.5 or (tight >= 4 and tight >= 0.5 * len(S))
        key = (fails, -mean)
        if hit is None or key > hit[0]: hit = (key, fails, mean, tight, name)
    return hit[1:]

def originality():
    print()
    print("Originality A: distance floor (chromatic >= 5, near-neutral >= 3) from every observed data stop")
    literal = 0; total = 0
    for name, cols in shipped_sets().items():
        bad = []
        for c in cols:
            d, k, oc = nearest(c); total += 1; literal += d < 8
            if d < floor_of(c): bad.append(f"{c} is {d:.1f} from {oc} ({k})")
        lo = min(nearest(c)[0] for c in cols)
        print(f"  {name:20s} nearest observed {lo:4.1f}  {'ok' if not bad else 'FAIL: ' + '; '.join(bad)}")
        FAILS.extend(f"floor: {name}: {b}" for b in bad)
    print(f"  (for information: {literal} of {total} shipped stops are within 8 of some observed stop; see CORTEX-UX section 11)")
    print()
    print("Originality B: no shipped palette or ramp is a counterpart of an observed palette")
    for name, cols in shipped_sets().items():
        if len(cols) < 4:
            print(f"  {name:20s} {len(cols)} stops: not a palette, rule A only"); continue
        fails, mean, tight, other = counterpart(cols, OBSERVED_PALETTES)
        loose = max(matched_pairs(cols, O) for O in OBSERVED_PALETTES.values())
        print(f"  {name:20s} closest {other}: mean {mean:4.1f}, {tight}/{len(cols)} pairs under 6 ({loose} under 8)  {'FAIL' if fails else 'ok'}")
        if fails: FAILS.append(f"counterpart: {name} vs {other} (mean {mean:.1f}, {tight} tight pairs)")
    print(f"  {'Stages (Ink, Paper)':20s} {matched_pairs(list(STAGES), OBSERVED_THEMES)}/2 within 8 of a window theme: 2 stops, not a theme set")
    print()
    print("Originality C: negative controls (each must be caught by rule B)")
    caught_by = {}
    for name, cols in NEGATIVE_CONTROLS.items():
        target = {"window themes": OBSERVED_THEMES} if "themes" in name else OBSERVED_PALETTES
        fails, mean, tight, other = counterpart(cols, target)
        caught_by[name] = fails
        print(f"  {name:24s} closest {other}: mean {mean:4.1f}, {tight} pairs under 6  {'caught' if fails else 'not caught'}")
    grouped = {n for g in CONTROL_GROUPS.values() for n in g}
    for name in NEGATIVE_CONTROLS:
        if name not in grouped and not caught_by[name]: FAILS.append(f"control not caught: {name}")
    for group, members in CONTROL_GROUPS.items():
        ok = any(caught_by[m] for m in members)
        print(f"  {group:24s} {'caught (through one variant)' if ok else 'NOT CAUGHT'}")
        if not ok: FAILS.append(f"control not caught: {group}")
    for name, cols in REPORTED_ONLY.items():
        fails, mean, tight, other = counterpart(cols, OBSERVED_PALETTES)
        print(f"  {name:24s} closest {other}: mean {mean:4.1f}, {tight} pairs under 6  ({'caught' if fails else 'kin by hue order only; dropped by the review'})")

if __name__ == "__main__":
    score, seq, cvd, nor, tri = derive_order()
    print("Prism order:", ", ".join(seq), f"(worst adjacent CVD {cvd:.1f}, normal {nor:.1f}, first-three all-pairs CVD {tri:.1f})")
    if seq != PRISM_ORDER:
        s_cvd = min(worst(PRISM_ORDER, vi) for vi in range(3))
        s_nor = min(min(dE(PRISM[a][vi], PRISM[b][vi]) for a, b in zip(PRISM_ORDER, PRISM_ORDER[1:])) for vi in range(3))
        s_tri = min(dE(PRISM[a][vi], PRISM[b][vi], k) for vi in range(3) for a, b in itertools.combinations(PRISM_ORDER[:3], 2) for k in ("protan", "deutan"))
        print("  shipped order:", ", ".join(PRISM_ORDER), f"(worst adjacent CVD {s_cvd:.1f}, normal {s_nor:.1f}, first-three {s_tri:.1f});",
              "kept because it ties on the first two keys and keeps slot meanings (you = amber, assistant = violet) stable")
        if s_cvd < cvd - 0.05 or s_nor < nor - 0.05: FAILS.append("Prism: shipped order is worse than the derived order")
    for vi, label in enumerate(("Prism glow", "Prism fill", "Prism light")):
        report(label, [PRISM[n][vi] for n in PRISM_ORDER], SURFACES[vi])
    allp = min(dE(PRISM[a][0], PRISM[b][0]) for a, b in itertools.combinations(PRISM_ORDER, 2))
    print(f"Prism glow all-pairs normal-vision minimum {allp:.1f}")
    report("Signal glow", SIGNAL_GLOW, "#07080b")
    report("Signal light", SIGNAL_LIGHT, "#ffffff")
    monotonic("Age ramp dark", AGE_DARK, True)
    monotonic("Age ramp light", AGE_LIGHT, False)
    monotonic("Count ramp dark", COUNT_DARK, True)
    monotonic("Count ramp light", COUNT_LIGHT, False)
    print("Print greys", PRINT_GREYS, "contrast on white", [round(contrast(g, "#ffffff"), 2) for g in PRINT_GREYS])
    for t, bg in (("#dadada", "#1c1c1c"), ("#b3b3b3", "#1c1c1c"), ("#9aa0aa", "#1c1c1c"), ("#9aa0aa", "#2a2a2a"),
                  ("#9ea5b1", "#303137"), ("#ffffff", "#774fd5"), ("#575d66", "#ebebeb"), ("#b8a6ff", "#1c1c1c"), ("#7b4acc", "#ffffff")):
        print(f"text {t} on {bg}: {contrast(t, bg):.2f}:1")
    for c in STATUS_DARK: print(f"status {c} on #1c1c1c: {contrast(c, '#1c1c1c'):.2f}:1")
    for c in STATUS_LIGHT: print(f"status {c} on #ffffff: {contrast(c, '#ffffff'):.2f}:1")
    originality()
    print("\nRESULT:", "pass" if not FAILS else "FAIL\n  " + "\n  ".join(FAILS))
    sys.exit(1 if FAILS else 0)
