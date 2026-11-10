"""Cortex art-direction prototype (docs/CORTEX-UX.md section 6): renders a static impression of the STANDING
nervous system from the home view (behind the figure, turned 30 degrees toward its right side, 6 degrees above):
the brain on top (a folded cerebrum split by its fissure, a temporal lobe under each lateral sulcus, the cerebellum
tucked under the back, the brainstem), the spinal cord running down the middle with the spine's gentle S-curve as
the time axis (oldest at the brainstem, newest at the bottom tip), 31 pairs of spinal nerves arching outward and
downward like ribs (every conversation's frond leaves the cord at its start time, on alternating sides, and runs out
in the nerve of its segment), the cauda equina fanning at the bottom and the undated cloud just below the tip.
Additive glow and exponential tone mapping (section 6.5).

Usage: python render_stage.py OUT.jpg WIDTH HEIGHT [--select] [--haze] [--top=PX] [--bottom=PX] [--cx=PX]
  --select  the main.png hero state: one conversation frond selected (double-click), so it and the notes built
            from it stay at full brightness while everything else dims (section 6.6).
  --haze    the first-run silhouette: anatomy haze only, at 1.5x rest brightness (section 5.2).
  --top     screen y of the brain's crown           (default 9% of HEIGHT; the clearance step may leave it at 8-11%; section 6.8 auto-framing)
  --bottom  screen y of the undated cloud's bottom  (default HEIGHT - 76: 16 px above the command line's top)
  --cx      screen x of the figure's centre         (default the free stage centre, (24 + WIDTH - 70) / 2)

Writes OUT.jpg (stage-sized) plus OUT.json with the screen positions the mockup overlays need (maps, cord,
brain, the selected frond, its notes and the source-line control points) and the composition numbers, including
the clearance between the figure and every stage overlay of the reference layout (section 3.2)."""
import math, json, sys
import numpy as np
from PIL import Image

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OPTS = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
SELECT = "--select" in sys.argv
HAZE_ONLY = "--haze" in sys.argv
OUT = ARGS[0] if len(ARGS) > 0 else "stage.jpg"
W, H = int(ARGS[1]) if len(ARGS) > 1 else 1576, int(ARGS[2]) if len(ARGS) > 2 else 825
TOP = float(OPTS.get("top", 0.09 * H))
BOTTOM = float(OPTS.get("bottom", H - 76))
XC = float(OPTS.get("cx", (24 + W - 70) / 2 if not HAZE_ONLY else W / 2))
SS = 2
rng = np.random.default_rng(7)
DIM_DATA, DIM_HAZE = (0.06, 0.35) if SELECT else ((0.0, 1.5) if HAZE_ONLY else (1.0, 1.0))   # section 6.6

# ---------------- palettes (Cortex tokens; values checked by palette_check.py) ----------------
def h2f(h): return np.array([int(h[i:i+2], 16) for i in (1, 3, 5)], dtype=np.float32) / 255.0
PRISM_GLOW = [h2f(c) for c in "#7ab9fd #deb125 #f58ebc #cbd871 #2eeafd #e6ac86 #c4a9ff #6ad39a".split()]
OTHER_GLOW = h2f("#b6bbd3"); NONE_GLOW = h2f("#727b8a")
AGE = [h2f(c) for c in "#866fc8 #5890ec #37acc3 #56c4a7 #90cf82 #cdd261 #e1d6ba #f0e0c6".split()]
def lin(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
PRISM_L = [lin(c) for c in PRISM_GLOW]; AGE_L = [lin(c) for c in AGE]
OTHER_L, NONE_L = lin(OTHER_GLOW), lin(NONE_GLOW)
def age_col(t):
    t = np.clip(np.atleast_1d(t), 0, 1) * (len(AGE_L) - 1); i = np.minimum(t.astype(int), len(AGE_L) - 2); f = (t - i)[:, None]
    A = np.stack(AGE_L)
    return A[i] * (1 - f) + A[i + 1] * f

# ================= anatomy (CORTEX-UX section 6.2; scene units, figure height 10) =================
# +Y up, +Z anterior (the face looks toward +Z), +X the figure's left. Crown y = +5.00, cord tip y = -4.02,
# lowest cauda strand y = -4.45, the undated cloud's lowest point y = -4.84.
CER_C, CER_AX, CER_E = np.array([0.0, 4.00, 0.06]), np.array([1.42, 1.02, 1.60]), 2.3   # cerebrum
CER_BASE_Y = 3.40                                       # flat base: no cerebrum point below it
FISSURE_HALF = 0.06                                    # longitudinal fissure half-width
TEMP_C, TEMP_AX, TEMP_E = np.array([0.80, 3.50, 0.34]), np.array([0.34, 0.31, 0.76]), 2.2   # temporal lobe (x mirrored)
SYLV_A, SYLV_B = np.array([1.02, 3.55]), np.array([-0.46, 4.00])   # lateral sulcus, (z, y) ends, on |x| > 0.5
CBL_C, CBL_AX = np.array([0.0, 3.16, -0.86]), np.array([1.02, 0.42, 0.62])   # cerebellum
# brainstem + cord centre line (y, z): midbrain, pons, medulla, then C1 ... tip; the cord's sagittal S-curve
# (cervical lordosis forward, thoracic kyphosis back, lumbar lordosis forward, sacral kyphosis back)
CL_YZ = np.array([(3.58, 0.00), (3.30, 0.08), (3.02, 0.02), (2.78, -0.08), (2.50, -0.02), (2.22, 0.04),
                  (1.90, -0.06), (1.30, -0.40), (0.55, -0.66), (-0.25, -0.58), (-0.95, -0.26), (-1.65, 0.02),
                  (-2.35, -0.10), (-2.95, -0.44), (-3.50, -0.62), (-4.02, -0.50)])
STEM_Y0, CORD_Y0, TIP_Y = 3.58, 2.74, -4.02
FLOOR_Y = -4.32                                          # nothing on a nerve goes below this
END_DROP = 0.22                                          # a nerve past its wrap limit turns down for at most this
UNDATED_C, UNDATED_S = np.array([0.0, -4.64, -0.42]), np.array([0.14, 0.10, 0.14])
# 31 spinal segments: exit levels (y) -- C1-C8 every 0.09, T1-T12 every 0.2285, L1-L5 every 0.30, S1-S5 every 0.22, Co1
Y_SEG = np.array([2.62 - 0.09 * i for i in range(8)] + [1.84 - 0.2285 * i for i in range(12)] +
                 [-0.94 - 0.30 * i for i in range(5)] + [-2.40 - 0.22 * i for i in range(5)] + [-3.56])
SEG_NAME = [f"C{i}" for i in range(1, 9)] + [f"T{i}" for i in range(1, 13)] + [f"L{i}" for i in range(1, 6)] + [f"S{i}" for i in range(1, 6)] + ["Co1"]
# nerve course per segment: leave angle below horizontal (deg), extra bend by the end (deg), wrap limit round the
# torso from the back (deg), full length (units)
NERVE = np.array([
    (38, 16, 60, 0.60), (32, 18, 62, 0.75), (26, 20, 66, 0.95), (18, 24, 72, 1.30),          # C1-C4  neck
    (8, 34, 84, 2.25), (5, 40, 88, 2.75), (4, 44, 90, 3.10), (3, 48, 90, 3.30),              # C5-C8  to the shoulders
    (3, 52, 90, 3.45), (3, 56, 92, 3.55), (4, 58, 92, 3.55), (4, 60, 92, 3.50),              # T1-T4  ribs
    (5, 60, 92, 3.40), (5, 60, 92, 3.30), (6, 60, 92, 3.15), (7, 58, 92, 3.00),              # T5-T8
    (8, 56, 90, 2.80), (10, 54, 90, 2.60), (12, 52, 90, 2.45), (14, 50, 90, 2.35),           # T9-T12 to the waist
    (18, 46, 90, 2.40), (24, 42, 88, 2.60), (30, 38, 86, 2.80), (36, 34, 84, 2.95), (42, 30, 80, 3.00),  # L1-L5 hips
    (46, 22, 76, 2.80), (30, 58, 70, 1.95), (32, 56, 60, 1.62), (35, 53, 50, 1.32), (39, 49, 40, 1.06),  # S1-S5 cauda
    (45, 43, 30, 0.84)], float)                                                                 # Co1
# torso envelope: half-width w(y) of the surface the nerves wrap round (shoulders, waist, hips, cauda fan)
ENV_Y = np.array([2.80, 2.55, 2.30, 2.05, 1.80, 1.50, 1.10, 0.50, -0.10, -0.60, -1.00, -1.40, -1.90, -2.40, -2.90, -3.40, -3.90, -4.32])
ENV_W = np.array([0.25, 0.55, 1.30, 2.35, 2.90, 3.02, 2.95, 2.65, 2.25, 1.88, 1.62, 1.58, 1.85, 2.30, 2.50, 2.30, 1.70, 1.15])
DEPTH_K = 0.40                                           # half-depth = 0.40 x half-width; the cord is on the back surface
def env_w(y):
    yy = np.asarray(y, float)
    a = np.interp(-yy, -ENV_Y, ENV_W); b = np.interp(-yy - 0.2, -ENV_Y, ENV_W); c = np.interp(-yy + 0.2, -ENV_Y, ENV_W)
    return 0.5 * a + 0.25 * (b + c)

# ---------------- noise ----------------
_frng = np.random.default_rng(11)
def _waves(k, m):
    d = _frng.normal(size=(m, 3)); d /= np.linalg.norm(d, axis=1, keepdims=True)
    return d * k, _frng.random(m) * 2 * math.pi
FOLD_WAVES = [(_waves(11.0, 16), 1.0), (_waves(19.0, 16), 0.38)]   # isotropic band-limited noise, two octaves
def fold_field(P):
    """Gyri: the zero set of isotropic two-octave wave noise (16 random directions per octave, wavenumbers 11 and
    19 per unit) drawn as crests: 1 on a crest line, 0 between them."""
    n = np.zeros(len(P))
    for (om, ph), amp in FOLD_WAVES:
        n += amp * np.sin(P @ om.T + ph).sum(axis=1) / math.sqrt(len(ph))
    return np.clip(1 - np.abs(n) / 0.50, 0, 1)

pts, cols, inten, layer, roles, inbrain = [], [], [], [], [], []
def add(P, C, I, L, role="data", brain=False):
    """role: data (dims to DIM_DATA when something is selected), haze (dims to DIM_HAZE), sel (stays lit).
    brain: the point takes the brain's own depth cue (section 6.5)."""
    if len(P) == 0: return
    inbrain.append(np.full(len(P), brain, bool))
    k = {"data": DIM_DATA, "haze": DIM_HAZE, "sel": 1.0}[role]
    pts.append(P.astype(np.float32)); cols.append(np.broadcast_to(C, (len(P), 3)).astype(np.float32))
    inten.append(np.broadcast_to(np.asarray(I, dtype=np.float32) * k, (len(P),)).copy()); layer.append(np.full(len(P), L, np.int8))
    roles.append(np.full(len(P), {"data": 0, "haze": 1, "sel": 2}[role], np.int8))

# ---------------- camera (section 6.8: home view, standing) ----------------
HEADING, ELEV, DIST = 154.0, 9.0, 25.0        # brain azimuth facing the camera (0 = frontal pole, 90 = the right side)
_h, _e = math.radians(HEADING), math.radians(ELEV)
CAM = np.array([-math.sin(_h) * math.cos(_e), math.sin(_e), math.cos(_h) * math.cos(_e)])   # unit, target -> camera
RGT = np.array([math.cos(_h), 0.0, math.sin(_h)])                                           # screen right
UPV = np.cross(CAM, RGT)                                                                     # screen up
R = np.stack([RGT, UPV, CAM])
VIEW = CAM
TARGET = np.array([0.0, 0.3, -0.2])

# ---------------- brain ----------------
def superellipsoid_dirs(n, ax, e):
    d = rng.normal(size=(n, 3)); d /= np.linalg.norm(d, axis=1, keepdims=True)
    s = (np.abs(d[:, 0] / ax[0]) ** e + np.abs(d[:, 1] / ax[1]) ** e + np.abs(d[:, 2] / ax[2]) ** e) ** (-1 / e)
    return d, s
def cerebrum_shape(P, c, with_slope=False):
    """Narrow the frontal and occipital poles, lift the frontal underside (orbital surface), lower the occipital
    pole a little, and sink the midline into the longitudinal fissure: a groove 0.26 deep at the crown whose steep
    walls face sideways, so they catch the rim light either side of the dark fissure."""
    q = P - c
    front = np.clip((q[:, 2] - 0.25) / 1.10, 0, 1); back = np.clip((-q[:, 2] - 0.45) / 0.95, 0, 1)
    P[:, 0] = c[0] + q[:, 0] * (1 - 0.12 * front - 0.10 * back)
    under = np.clip(-q[:, 1] / 0.8, 0, 1)
    P[:, 1] += 0.22 * np.clip((q[:, 2] - 0.1) / 1.2, 0, 1) * under - 0.08 * back ** 2
    groove = 0.26 * np.exp(-(q[:, 0] / 0.11) ** 2) * np.clip((q[:, 1] + 0.55) / 1.0, 0, 1)
    slope = np.minimum(2 * np.abs(q[:, 0]) / 0.11 ** 2 * groove, 3.0)
    rr = np.linalg.norm(q, axis=1) + 1e-9
    P -= (groove / rr)[:, None] * np.stack([np.zeros(len(q)), q[:, 1], q[:, 2]], 1)
    return (P, slope) if with_slope else P
def sylvian_dist(P):
    """Distance in the (z, y) plane from the lateral sulcus line (both sides; only meaningful where |x| > 0.5)."""
    p = np.stack([P[:, 2], P[:, 1]], 1); ab = SYLV_B - SYLV_A
    t = np.clip(((p - SYLV_A) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(p - (SYLV_A + t[:, None] * ab), axis=1), t
def above_sylvian(P):
    ab = SYLV_B - SYLV_A
    return (P[:, 1] - SYLV_A[1]) * ab[0] - (P[:, 2] - SYLV_A[0]) * ab[1] < 0   # sign of the cross product
def folded_surface(n, c, ax, e, shape=None, keep_pow=4):
    """Surface slots on a superellipsoid, denser on gyral crests and pushed in between them."""
    d, s = superellipsoid_dirs(n * 5, ax, e)
    P = c + d * s[:, None]
    if shape is cerebrum_shape:      # the fissure's walls face sideways: tilt the normal toward the midline
        P, slope = shape(P, c, True)
        d = d - (np.sign(P[:, 0] - c[0]) * slope * 0.7)[:, None] * np.array([1.0, 0, 0])
        d /= np.linalg.norm(d, axis=1, keepdims=True)
    elif shape is not None: P = shape(P, c)
    f = fold_field(P)
    keep = rng.random(len(P)) < 0.04 + 0.96 * f ** keep_pow
    P, d, f = P[keep][:n], d[keep][:n], f[keep][:n]
    P = c + (P - c) * (1 + 0.04 * (f - 0.55))[:, None]
    return P, d, f
def inside(P, c, ax, e, k=1.0):
    q = np.abs((P - c) / (ax * k))
    return (q[:, 0] ** e + q[:, 1] ** e + q[:, 2] ** e) < 1
def cerebrum_keep(P):
    """Cut the flat base, the fissure (top and back) and the lateral sulci."""
    fis = (np.abs(P[:, 0]) < FISSURE_HALF) & ((P[:, 1] > 3.78) | (P[:, 2] < -0.55))
    sd, st = sylvian_dist(P)
    syl = (np.abs(P[:, 0]) > 0.50) & (sd < 0.045 + 0.02 * st)
    tent = (P[:, 1] < 3.53) & (P[:, 2] < -0.35)              # the occipital lobe rests above the cerebellum
    return (P[:, 1] > CER_BASE_Y) & ~fis & ~syl & ~tent

N_NOTES = 4706
area_counts = np.array([512, 1203, 988, 1021, 402, 214, 151, 98, 117], float)  # 8 slots + other (brain notes)
wedge_w = area_counts ** 0.6; wedge_w /= wedge_w.sum()
wedge_edges = np.concatenate([[0], np.cumsum(wedge_w)]) * 2 * math.pi
def wedge_of(P):   # azimuth about the brain's vertical axis: 0 at the frontal pole, then over the figure's right side
    phi = (np.arctan2(-(P[:, 0] - CER_C[0]), P[:, 2] - CER_C[2]) + 2 * math.pi) % (2 * math.pi)
    return np.clip(np.searchsorted(wedge_edges, phi, side="right") - 1, 0, 8)
def terr_col(wi): return np.stack([PRISM_L[i] if i < 8 else OTHER_L for i in wi]) if len(wi) else np.zeros((0, 3))

def temporal_surface(n, sgn, ax_k=1.0, pw=4):
    c = TEMP_C * np.array([sgn, 1, 1])
    d, s = superellipsoid_dirs(n * 6, TEMP_AX * ax_k, TEMP_E)
    P = c + d * s[:, None]
    q = P - c
    P[:, 1] -= 0.10 * np.clip(q[:, 2] / TEMP_AX[2], 0, 1) ** 1.5           # the temporal pole points forward and down
    f = fold_field(P)
    keep = (rng.random(len(P)) < 0.04 + 0.96 * f ** pw) & ~inside(P, CER_C, CER_AX, CER_E, 0.97) & ~above_sylvian(P)
    sd, _ = sylvian_dist(P)
    keep &= sd > 0.05
    return P[keep][:n], d[keep][:n], f[keep][:n]
def cerebellum_surface(n, scale=1.0, fill=0.8):
    """Two lateral lobes and the vermis; folia as curved bands round its transverse axis."""
    d, s = superellipsoid_dirs(n * 8, CBL_AX * scale, 2.0)
    r = np.where(rng.random(len(d)) < fill, 1.0, rng.random(len(d)) ** 0.4)
    P = CBL_C + d * (s * r)[:, None]
    q = P - CBL_C
    notch = 0.07 * np.exp(-(q[:, 0] / 0.13) ** 2) * (q[:, 1] > -0.1)       # the vermis notch between the lobes
    P[:, 1] -= notch
    psi = np.arctan2(q[:, 1], -q[:, 2])
    fol = (0.5 + 0.5 * np.cos(20 * psi)) ** 3
    keep = (rng.random(len(P)) < 0.15 + 0.85 * fol) & ~inside(P, CER_C, CER_AX, CER_E, 1.0) & (P[:, 1] < 3.45)
    return P[keep][:n], d[keep][:n]

brain, brain_n, brain_shell, brain_f = [], [], [], []
# cerebrum: 74% of the notes, 80% of them on the folded surface (the hemisphere is the sign of x)
n = int(N_NOTES * 0.74)
P, d, f = folded_surface(int(n * 1.35), CER_C, CER_AX, CER_E, cerebrum_shape, keep_pow=7)
shell = rng.random(len(P)) < 0.88
r = np.where(shell, 1.0, rng.random(len(P)) ** 0.5 * 0.86)
P = CER_C + (P - CER_C) * r[:, None]
m = cerebrum_keep(P) & ~(~shell & (np.abs(P[:, 0]) < 0.10))
for sgn in (-1, 1):   # cerebrum surface points buried inside a temporal lobe are not on the outside
    m &= ~(inside(P, TEMP_C * np.array([sgn, 1, 1]), TEMP_AX, TEMP_E, 0.95) & shell)
brain.append(P[m][:n]); brain_n.append(d[m][:n]); brain_shell.append(shell[m][:n]); brain_f.append(f[m][:n])
for sgn in (-1, 1):   # temporal lobes: 5% each
    n = int(N_NOTES * 0.05)
    P, d, f = temporal_surface(n, sgn)
    brain.append(P); brain_n.append(d); brain_shell.append(np.ones(len(P), bool)); brain_f.append(f)
B = np.concatenate(brain); BN = np.concatenate(brain_n); BS = np.concatenate(brain_shell); BF = np.concatenate(brain_f)
wi = wedge_of(B)
bc = terr_col(wi)
rim = 1 - np.abs(BN @ VIEW)
bI = 1.7 * rng.uniform(0.75, 1.2, len(B)) * (0.70 + 1.1 * rim ** 2) * np.where(BS, 1.0, 0.7) * (0.45 + 0.55 * BF)
# notes built from the selected conversation: Roblox wedge (slot 3), on the surface, facing the camera
SEL_NOTES = np.zeros(len(B), bool)
if SELECT:
    facing = BN @ VIEW
    cand = np.where((wi == 2) & BS & (facing > 0.40) & (B[:, 1] > 3.85))[0]
    pick = cand[np.argsort(-facing[cand])][:: max(1, len(cand) // 80)][:80]
    chosen = []
    for i in pick:   # spread them out
        if all(np.linalg.norm(B[i] - B[j]) > 0.36 for j in chosen): chosen.append(i)
        if len(chosen) == 6: break
    SEL_NOTES[chosen] = True
add(B[~SEL_NOTES], bc[~SEL_NOTES], bI[~SEL_NOTES], 1, brain=True)
if SELECT: add(B[SEL_NOTES], bc[SEL_NOTES], bI[SEL_NOTES] * 1.8, 2, "sel", brain=True)
# cerebellum: 16% of the notes
n = int(N_NOTES * 0.16)
P, d = cerebellum_surface(n)
CB_P = P
rimc = 1 - np.abs(d @ VIEW)
add(P, terr_col(wedge_of(P)), 1.5 * (0.75 + 0.6 * rimc ** 2), 1, brain=True)
# brainstem (haze): midbrain, pons swelling forward, medulla
def catmull(ctrl, ts):
    n = len(ctrl) - 1; out = []
    for t in ts:
        u = t * n; i = min(int(u), n - 1); f = u - i
        p0 = ctrl[max(i - 1, 0)]; p1 = ctrl[i]; p2 = ctrl[i + 1]; p3 = ctrl[min(i + 2, n)]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f ** 3))
    return np.array(out)
TT = np.linspace(0, 1, 4001); CYZ = catmull(CL_YZ, TT)
_seg = np.linalg.norm(np.diff(CYZ, axis=0), axis=1); ARC = np.concatenate([[0], np.cumsum(_seg)]); CL_LEN = ARC[-1]; ARC = ARC / CL_LEN
def cl_at(tau):
    """Centre line (x, y, z) at tau (arc fraction from the brainstem's top, 0, to the cord tip, 1)."""
    tau = np.atleast_1d(tau).astype(float)
    u = np.interp(tau, ARC, TT)
    i = np.clip((u * 4000).astype(int), 0, 3999); f = (u * 4000 - i)
    yz = CYZ[i] * (1 - f)[:, None] + CYZ[i + 1] * f[:, None]
    return np.stack([np.zeros(len(tau)), yz[:, 0], yz[:, 1]], 1)
def tau_of_y(y): return np.interp(-np.asarray(y, float), -CYZ[:, 0], ARC)
def z_cord(y): return np.interp(-np.asarray(y, float), -CYZ[:, 0], CYZ[:, 1])
RAD_Y = np.array([3.58, 3.30, 2.95, 2.70, 2.15, 1.50, -0.80, -1.60, -2.60, -4.02])
RAD_R = np.array([0.20, 0.25, 0.15, 0.10, 0.115, 0.095, 0.08, 0.095, 0.07, 0.045])
def cord_radius(y): return np.interp(-np.asarray(y, float), -RAD_Y, RAD_R)
TAU_SEG = tau_of_y(Y_SEG)
SEG_EDGE = np.concatenate([[0.0], (TAU_SEG[1:] + TAU_SEG[:-1]) / 2, [1.0001]])
TAU_C1 = float(tau_of_y(CORD_Y0))
n = 700
t = rng.random(n) * TAU_C1
C = cl_at(t); a = rng.random(n) * 2 * math.pi
rad = cord_radius(C[:, 1]) * np.sqrt(rng.random(n))
fwd = 1 + 0.35 * np.exp(-((C[:, 1] - 3.25) / 0.16) ** 2) * (0.5 + 0.5 * np.cos(a))      # pons swells forward
P = C + np.stack([np.sin(a) * rad, np.zeros(n), np.cos(a) * rad * fwd], 1)
add(P, age_col(np.zeros(n) + 0.02) * 0.6 + 0.4 * OTHER_L, 0.55, 0, "haze")
# brain haze (decorative), tinted by territory: 55% traces the folds, 30% fills the cerebrum, 15% the cerebellum
NH = 14000
P1, d1, _ = folded_surface(int(NH * 0.60), CER_C, CER_AX * 1.01, CER_E, cerebrum_shape, keep_pow=6)
k1 = cerebrum_keep(P1); P1, d1 = P1[k1], d1[k1]
for sgn in (-1, 1):
    Pt, dt, _ = temporal_surface(int(NH * 0.04), sgn, 1.01, 6); P1 = np.concatenate([P1, Pt]); d1 = np.concatenate([d1, dt])
rim1 = 1 - np.abs(d1 @ VIEW)
dv, sv = superellipsoid_dirs(int(NH * 0.25), CER_AX * 0.96, CER_E)
P2 = CER_C + dv * (sv * rng.random(len(dv)) ** 0.33)[:, None]; P2 = P2[(P2[:, 1] > CER_BASE_Y + 0.05) & (np.abs(P2[:, 0]) > 0.10)]
P3, _ = cerebellum_surface(int(NH * 0.15), 1.02, 0.9)
add(P1, terr_col(wedge_of(P1)) * 0.6 + 0.4 * OTHER_L, 0.80 * (0.6 + 1.0 * rim1 ** 2), 0, "haze", True)      # the folds, rim-lit
# the fissure's lips (haze): the hemispheres' upper edges either side of the longitudinal fissure, over the crown and
# down the back to the tentorium, so the split between the hemispheres reads from any side
dl, sl_ = superellipsoid_dirs(60000, CER_AX, CER_E)
PL, _ = cerebrum_shape(CER_C + dl * sl_[:, None], CER_C, True)
lip = (np.abs(PL[:, 0]) > FISSURE_HALF) & (np.abs(PL[:, 0]) < FISSURE_HALF + 0.05) & ((PL[:, 1] > 3.70) | (PL[:, 2] < -0.45)) & (PL[:, 1] > 3.55)
PL = PL[lip][:1800]
add(PL, terr_col(wedge_of(PL)) * 0.5 + 0.5 * OTHER_L, 0.55, 0, "haze", True)
add(P2, terr_col(wedge_of(P2)) * 0.6 + 0.4 * OTHER_L, 0.12, 0, "haze", True)      # the volume
add(P3, terr_col(wedge_of(P3)) * 0.6 + 0.4 * OTHER_L, 0.50, 0, "haze", True)      # the cerebellum's folia

# ---------------- cord ----------------
# core points (documents, passages, files: single entries in the cord at their tau)
n = 5200
tau = TAU_C1 * 0.5 + (0.97 - TAU_C1 * 0.5) * rng.random(n)
C = cl_at(tau)
rad = cord_radius(C[:, 1]) * np.abs(rng.normal(size=n)) * 0.7
a = rng.random(n) * 2 * math.pi
P = C + np.stack([np.cos(a) * rad, np.zeros(n), np.sin(a) * rad], 1)
add(P, age_col(tau), 1.0, 0)
# the cord thread (haze): a fine continuous line down the centre, tinted by age, so the spine reads at any density
n = 3000
tau = np.sort(rng.random(n))
C = cl_at(tau)
rad = cord_radius(C[:, 1]) * np.abs(rng.normal(size=n)) * 0.22
a = rng.random(n) * 2 * math.pi
P = C + np.stack([np.cos(a) * rad, np.zeros(n), np.sin(a) * rad], 1)
add(P, age_col(tau) * 0.5 + 0.5 * OTHER_L, 0.95, 0, "haze")
# segment rings (haze): a faint mist ring round the cord at each of the 31 exit levels
for k in range(31):
    Ck = cl_at(np.array([TAU_SEG[k]]))[0]
    m_ = 40; a = np.linspace(0, 2 * math.pi, m_, endpoint=False) + rng.random() * 0.3
    rr = 0.15 * (1 - TAU_SEG[k]) + 0.08 * TAU_SEG[k]
    P = Ck + np.stack([np.cos(a) * rr, np.zeros(m_), np.sin(a) * rr], 1)
    add(P, OTHER_L, 0.20, 0, "haze")

# ---------------- spinal nerves: one course for the anatomy's nerves and the conversation fronds ----------------
def nerve_courses(k_idx, side, length, K=56):
    """Courses for many nerves at once. Each leaves the cord at its segment's exit level on side (+1 the figure's
    right, -1 its left), heading out sideways at the segment's leave angle and bending further down toward its end,
    while it wraps forward round the torso envelope (an ellipse of half-width w(y) and half-depth 0.52 w(y) whose
    back is on the cord). Past the wrap limit it only descends. It never goes below FLOOR_Y."""
    k_idx = np.asarray(k_idx); n = len(k_idx)
    a0, da, pm = np.radians(NERVE[k_idx, 0]), np.radians(NERVE[k_idx, 1]), np.radians(NERVE[k_idx, 2])
    y = Y_SEG[k_idx].astype(float).copy(); phi = np.zeros(n); tail = np.zeros(n)
    out = np.zeros((K + 1, n, 3)); out[0, :, 1] = y; out[0, :, 2] = z_cord(y)
    ds = np.asarray(length, float) / K
    sx = -np.asarray(side, float)                  # +X is the figure's left
    for j in range(K):
        a = a0 + da * ((j + 0.5) / K) ** 2.2
        dh, dv = np.cos(a) * ds, np.sin(a) * ds
        w = env_w(y); d = w * DEPTH_K
        speed = np.sqrt((w * np.cos(phi)) ** 2 + (d * np.sin(phi)) ** 2) + 1e-6
        capped = phi >= pm - 1e-6
        phi_prev = phi
        phi = np.minimum(phi + np.where(capped, 0.0, dh / speed), pm)
        drop = np.where(capped, np.where(tail < END_DROP, ds, 0.0), dv)      # past the wrap limit: a short end piece
        tail = tail + np.where(capped, drop, 0.0)
        floored = y <= FLOOR_Y + 1e-6                                      # a nerve that reaches the floor stops there
        phi = np.where(floored, phi_prev, phi) if j else phi
        y = np.maximum(y - np.where(floored, 0.0, drop), FLOOR_Y)
        w = env_w(y); d = w * DEPTH_K
        out[j + 1, :, 0] = sx * w * np.sin(phi)
        out[j + 1, :, 1] = y
        out[j + 1, :, 2] = z_cord(y) + d * (1 - np.cos(phi))
    return out.transpose(1, 0, 2)          # (n, K+1, 3)

def along(path, fr):
    """Points at arc fractions fr along one polyline path (K+1, 3); also the local unit direction."""
    sl = np.linalg.norm(np.diff(path, axis=0), axis=1); cum = np.concatenate([[0], np.cumsum(sl)]); L = cum[-1] + 1e-9
    s = np.clip(fr, 0, 1) * L
    j = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(path) - 2)
    f = ((s - cum[j]) / (sl[j] + 1e-9))[:, None]
    d = (path[j + 1] - path[j]) / (sl[j][:, None] + 1e-9)
    return path[j] * (1 - f) + path[j + 1] * f, d
def path_len(path): return float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum())
DOWN = np.array([0.0, -1.0, 0.0])
def branch(P0, dloc, side, L, kb, ang_deg):
    """A side branch leaving a nerve at P0: angled ang_deg off the nerve toward the outside-down, slightly curved."""
    outward = np.array([-side, 0.0, 0.0])
    bend = DOWN * 0.8 + outward * 0.6; bend -= (bend @ dloc) * dloc; bend /= np.linalg.norm(bend) + 1e-9
    ang = math.radians(ang_deg)
    bd = math.cos(ang) * dloc + math.sin(ang) * bend
    sb = np.linspace(0, 1, kb)
    bp = P0 + np.outer(sb, bd) * L + np.outer(sb ** 2, DOWN) * L * 0.18
    bp[:, 1] = np.maximum(bp[:, 1], FLOOR_Y)
    return bp

# the anatomy's 31 pairs (haze): full-length guides, each with two twigs near its end
gk = np.repeat(np.arange(31), 2); gs = np.tile([1.0, -1.0], 31)
GP = nerve_courses(gk, gs, NERVE[gk, 3])
for i in range(62):
    k, s = gk[i], gs[i]
    nn = int(60 + 50 * NERVE[k, 3])
    P, dirs = along(GP[i], np.sort(rng.random(nn)) ** 0.9)
    P += rng.normal(size=P.shape) * 0.010
    add(P, OTHER_L, 0.24 * np.linspace(1.0, 0.55, nn), 0, "haze")
    L = path_len(GP[i])
    for fr0 in (0.62, 0.80):
        p0, d0 = along(GP[i], np.array([fr0 + 0.05 * rng.random()]))
        bp = branch(p0[0], d0[0], s, L * 0.22, 26, 24 + 8 * rng.random())
        add(bp + rng.normal(size=bp.shape) * 0.008, OTHER_L, 0.16, 0, "haze")

# ---------------- fronds (conversations) ----------------
# 3 imported sources over time: ChatGPT 2023-24, Claude.ai 2024-26, Claude Code Oct-Nov 2026 (rank-warped tau)
N_CONV = 2507
sizes = np.clip((rng.pareto(1.35, N_CONV) + 1) * 9, 2, 2400).astype(int)
sizes = (sizes * (97519 / sizes.sum())).astype(int) + 1
order = np.sort(rng.random(N_CONV))
late = order > 0.62                       # the latest period (Claude Code) carries bigger conversations
sizes[late] = (sizes[late] * 2.1).astype(int)
sizes = (sizes * (97519 / sizes.sum())).astype(int) + 1
cum = np.cumsum(sizes); tot = cum[-1]
tau0 = 0.06 + 0.88 * (cum - sizes) / tot   # rank-based start
side = np.where(np.arange(N_CONV) % 2 == 0, 1.0, -1.0)      # alternating sides, in start order (+1 the right)
seg_of = np.clip(np.searchsorted(SEG_EDGE, tau0, side="right") - 1, 0, 30)
frac = np.clip(0.30 + 0.15 * np.log1p(sizes / 10.0), 0.25, 1.0) * rng.uniform(0.9, 1.1, N_CONV)
frac = np.clip(frac, 0.12, 1.0)
CI_SEL = -1; SEL_FROND = None
if SELECT:   # a long Claude Code conversation from early November: among the newest nerves (S2), on the near side
    ok = np.where((sizes >= 200) & (side > 0) & (seg_of == SEG_NAME.index("S2")))[0]
    if len(ok) == 0: ok = np.where((side > 0) & (seg_of == SEG_NAME.index("S2")))[0]
    CI_SEL = int(ok[np.argmax(sizes[ok])])
    sizes[CI_SEL] = 549; frac[CI_SEL] = 0.95
FL = frac * NERVE[seg_of, 3]
FP = nerve_courses(seg_of, side, FL)
budget_fronds = 0
ROOTLET = 0.22
bundle = rng.normal(size=(N_CONV, 2)) * 0.011                 # each frond's place inside its nerve (y, z)
splay = rng.normal(size=(N_CONV, 3)); splay[:, 1] = -np.abs(splay[:, 1]); splay /= np.linalg.norm(splay, axis=1, keepdims=True)
for ci in range(N_CONV):
    nmsg = sizes[ci]; path = FP[ci].copy(); s_ = side[ci]
    # rootlet: from the cord at the conversation's own start time to the nerve, 0.22 out from the cord
    sl = np.linalg.norm(np.diff(path, axis=0), axis=1); cumL = np.concatenate([[0], np.cumsum(sl)])
    j = int(np.searchsorted(cumL, ROOTLET)); j = min(max(j, 1), len(path) - 1)
    root = cl_at(np.array([tau0[ci]]))[0]
    path = np.concatenate([root[None], path[j:]])
    k = max(3, min(nmsg, 900))
    s = np.sort(rng.random(k)) ** 0.85
    P, dirs = along(path, s)
    u = np.clip((s * path_len(path) - ROOTLET) / max(path_len(path) - ROOTLET, 1e-6), 0, 1)
    P[:, 1] += bundle[ci, 0] * (0.3 + 0.9 * u); P[:, 2] += bundle[ci, 1] * (0.3 + 0.9 * u)
    tail = np.clip((s - 0.80) / 0.20, 0, 1) ** 1.5
    P += np.outer(tail, splay[ci]) * 0.10 * (0.5 + 0.5 * frac[ci])
    P += rng.normal(size=(k, 3)) * (0.004 + 0.009 * s)[:, None]
    # parts: one branch per ~180 messages (at most 4), leaving the outer half of the frond
    nb = min(4, nmsg // 180)
    L = path_len(path)
    for b in range(nb):
        at = int(rng.integers(k // 2, max(k // 2 + 1, k - 2)))
        bp = branch(P[at], dirs[at], s_, min(L * 0.24, 0.8), max(8, k // (3 + b)), 22 + 10 * rng.random())
        P = np.concatenate([P, bp + rng.normal(size=bp.shape) * 0.012])
    P[:, 1] = np.maximum(P[:, 1], FLOOR_Y - 0.03)
    col = age_col(np.full(len(P), (tau0[ci] - 0.06) / 0.88))
    I = (0.60 - 0.24 * np.linspace(0, 1, len(P))) * rng.uniform(0.85, 1.15)
    if ci == CI_SEL:
        add(P, col, I * 3.0, 0, "sel"); SEL_FROND = (path.copy(), int(nmsg), float(tau0[ci]), int(seg_of[ci]))
    else:
        add(P, col, I, 0)
    budget_fronds += len(P)

# undated cloud just below the tip
n = 520
P = UNDATED_C + np.clip(rng.normal(size=(n, 3)), -2.2, 2.2) * UNDATED_S     # truncated at 2.2 sigma
add(P, NONE_L, 1.3, 0)

# maps (beacons) in the brain
hub_idx = rng.choice(len(B), 18, replace=False)
HB = CER_C + (B[hub_idx] - CER_C) * 1.03
add(HB, np.ones((len(HB), 3)) * 0.6 + 0.4 * terr_col(wi[hub_idx]), 1.0, 2, brain=True)

P = np.concatenate(pts); Cc = np.concatenate(cols); I = np.concatenate(inten); Ly = np.concatenate(layer); Ro = np.concatenate(roles); IB = np.concatenate(inbrain)
print("points", len(P), "fronds", budget_fronds, "haze", int((Ro == 1).sum()), file=sys.stderr)

# ---------------- auto-framing (section 6.8): fit the figure's height, centre it in the free stage ----------------
def proj_norm(P):
    Q = (P - TARGET) @ R.T
    zz = DIST - Q[:, 2]
    return Q[:, 0] / zz, Q[:, 1] / zz, Q[:, 2]
u_all, v_all, zc = proj_norm(P)
v_top = proj_norm(B)[1].max()
cloud_low = UNDATED_C - np.array([0, 2.2 * UNDATED_S[1], 0])
v_bot = min(proj_norm(cloud_low[None])[1][0], np.percentile(v_all, 0.02))
F = (BOTTOM - TOP) / (v_top - v_bot)
CY = TOP + F * v_top
data_mask = (Ro != 1) if not HAZE_ONLY else (Ro == 1)      # frame on the data (or, for the silhouette, the haze)
uu = u_all[data_mask]
u_lo, u_hi = np.percentile(uu, 0.3), np.percentile(uu, 99.7)
CX = XC - F * (u_lo + u_hi) / 2
# stage overlays of the reference layout (section 3.2), stage-local CSS px: the sheet open (1176 wide) or not (1576)
RECTS = {"key bar": (16, 12, 16 + min(0.44 * W, 693), 78), "shape bar": (W - 436, 12, W - 16, 52),
         "tool column": (W - 54, 64, W - 16, 336), "compass": (16, H - 166, 156, H - 16),
         "command line": (W / 2 - 320, H - 60, W / 2 + 320, H - 16)}
VISIBLE = None
def clearances(F_, CX_, CY_):
    x = CX_ + F_ * u_all[VISIBLE]; y = CY_ - F_ * v_all[VISIBLE]
    out = {}
    for k_, (x0, y0, x1, y1) in RECTS.items():
        dx = np.maximum(np.maximum(x0 - x, x - x1), 0); dy = np.maximum(np.maximum(y0 - y, y - y1), 0)
        out[k_] = round(float(np.sqrt(dx ** 2 + dy ** 2).min()), 1)
    return out
SHRINK_STEPS = 0
# depth cue
dn = (zc - zc.min()) / (zc.max() - zc.min() + 1e-9)
cue = 0.55 + 0.45 * dn ** 0.8
bm = IB
dnb = (zc - zc[bm].min()) / (zc[bm].max() - zc[bm].min() + 1e-9)
cue = np.where(bm, 0.16 + 0.84 * np.clip(dnb, 0, 1) ** 1.6, cue)
VISIBLE = (I * cue) > (0.05 if SELECT else 0.02)
if not HAZE_ONLY:
    gx, gy = CX + F * (u_lo + u_hi) / 2, CY - F * (v_top + v_bot) / 2      # the figure's centre on screen
    SHIFT = 0
    while min(clearances(F, CX, CY).values()) < 8 and SHRINK_STEPS < 12:
        if SHIFT < 6: CX += 6; SHIFT += 1; continue            # first slide the figure right (at most 36 px) ...
        F *= 0.98; CX = gx + SHIFT * 6 - F * (u_lo + u_hi) / 2; CY = gy + F * (v_top + v_bot) / 2; SHRINK_STEPS += 1   # ... then shrink
f = F * SS
cx, cy = CX * SS, CY * SS
def project(P):
    u, v, q = proj_norm(P)
    return cx + f * u, cy - f * v, q
sx, sy, _ = project(P)
WW, HH = W * SS, H * SS
def splat(mask):
    acc = np.zeros((3, HH, WW), np.float32)
    x, y = sx[mask], sy[mask]
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - ix, y - iy
    w = (I[mask] * cue[mask])[:, None] * Cc[mask]
    for dx, dy, ww in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        X, Y = ix + dx, iy + dy
        ok = (X >= 0) & (X < WW) & (Y >= 0) & (Y < HH)
        for ch in range(3):
            np.add.at(acc[ch], (Y[ok], X[ok]), (w[ok, ch] * ww[ok]))
    return acc

def gauss_kernel_fft(sig, shape):
    hh, ww = shape
    yy = np.fft.fftfreq(hh)[:, None]; xx = np.fft.fftfreq(ww)[None, :]
    return np.exp(-2 * (math.pi ** 2) * (sig ** 2) * (xx ** 2 + yy ** 2))

hdr = np.zeros((3, HH, WW), np.float32)
# per layer: core sigma, halo sigma (CSS px), core peak, halo peak  (peak-normalised splats)
LAYERS = {0: (0.55, 2.8, 0.105, 0.0105), 1: (0.85, 3.8, 0.60, 0.035), 2: (1.4, 6.5, 0.95, 0.16)}
for L_id, (sc, sh, cp, hp) in LAYERS.items():
    m = Ly == L_id
    if not m.any(): continue
    acc = splat(m)
    Kc = gauss_kernel_fft(sc * SS, (HH, WW))[:, :WW // 2 + 1]; Kh = gauss_kernel_fft(sh * SS, (HH, WW))[:, :WW // 2 + 1]
    for ch in range(3):
        Fq = np.fft.rfft2(acc[ch])
        core = np.fft.irfft2(Fq * Kc, s=(HH, WW)) * (2 * math.pi * (sc * SS) ** 2)
        halo = np.fft.irfft2(Fq * Kh, s=(HH, WW)) * (2 * math.pi * (sh * SS) ** 2)
        hdr[ch] += cp * core + hp * halo

k = 1.35
mapped = 1 - np.exp(-k * np.maximum(hdr, 0))
# background: Ink stage with a tall soft lift behind the standing figure, and a corner vignette
yy, xx = np.mgrid[0:HH, 0:WW].astype(np.float32)
lx, ly = XC * SS, (TOP + BOTTOM) / 2 * SS
r = np.sqrt(((xx - lx) / (WW * 0.46)) ** 2 + ((yy - ly) / (HH * 0.80)) ** 2)
base = lin(h2f("#06070a")); lift = lin(h2f("#0e121a"))
t = np.clip(1 - r, 0, 1) ** 1.6
bg = base[:, None, None] * (1 - t) + lift[:, None, None] * t
rc = np.sqrt(((xx - WW / 2) / (WW * 0.62)) ** 2 + ((yy - HH / 2) / (HH * 0.75)) ** 2)
vign = np.clip(1.0 - 0.35 * np.clip(rc - 0.75, 0, 1), 0, 1)
bg = bg * vign
out = bg + mapped - bg * mapped
def enc(c): return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(np.clip(c, 0, 1), 1 / 2.4) - 0.055)
img = (np.clip(enc(out), 0, 1) * 255).astype(np.uint8).transpose(1, 2, 0)
im = Image.fromarray(img).resize((W, H), Image.LANCZOS)
im.save(OUT, quality=92, optimize=True, progressive=True, subsampling=0)

# ---------------- export overlay anchors and composition ----------------
def scr(p):
    x, y, _ = project(np.array([p], float))
    return [round(float(x[0]) / SS, 1), round(float(y[0]) / SS, 1)]
bx, byy, _ = project(np.concatenate([B, CB_P]))
top_i = int(np.argmin(byy))
hub_screen = [(scr(HB[i]), int(wi[hub_idx][i])) for i in range(len(HB))]
tipP = cl_at(np.array([1.0]))[0]
fx_all, fy_all = sx / SS, sy / SS
vis = (I * cue) > (0.05 if SELECT else 0.02)
bbox = [round(float(np.percentile(fx_all[vis], 0.2)), 1), round(float(fy_all[vis].min()), 1),
        round(float(np.percentile(fx_all[vis], 99.8)), 1), round(float(fy_all[vis].max()), 1)]
anchors = {
    "pose": "standing", "heading_deg": HEADING, "elevation_deg": ELEV,
    "brainstem": scr(cl_at(np.array([TAU_C1]))[0]), "tip": scr(tipP), "undated": scr(UNDATED_C), "undated_low": scr(cloud_low),
    "brain_center": scr(CER_C), "brain_top": [round(float(bx[top_i]) / SS, 1), round(float(byy[top_i]) / SS, 1)],
    "brain_bbox": [round(float(np.percentile(bx, 0.3)) / SS, 1), round(float(byy.min()) / SS, 1),
                   round(float(np.percentile(bx, 99.7)) / SS, 1), round(float(np.percentile(byy, 99.7)) / SS, 1)],
    "hubs": hub_screen,
    "cord": [scr(cl_at(np.array([t]))[0]) for t in np.linspace(0, 1, 21)],
    "segments": {SEG_NAME[k]: scr(cl_at(np.array([TAU_SEG[k]]))[0]) for k in range(31)},
    "frame": {"top": TOP, "bottom": BOTTOM, "cx": XC, "px_per_unit": round(float(F) / DIST, 2), "bbox": bbox,
              "top_pct": round(100 * float(byy.min()) / SS / H, 1),
              "clearance": clearances(F, CX, CY), "shrink_steps": SHRINK_STEPS,
              "time_strip_gap": round(H - float(fy_all[vis].max()), 1)},
}
if SELECT and SEL_FROND is not None:
    path, nmsg, t0, sk = SEL_FROND
    idx = np.linspace(0, len(path) - 1, 24).astype(int)
    anchors["frond"] = {"messages": nmsg, "tau": round(t0, 4), "segment": SEG_NAME[sk], "side": "right", "root": scr(path[0]),
                        "path": [scr(path[i]) for i in idx], "end": scr(path[-1])}
    notes = B[np.where(SEL_NOTES)[0]]
    anchors["notes"] = [scr(p) for p in notes]
    # source lines (section 6.10): from each note to 3 of its messages on the frond, a quadratic curve whose control
    # point sits level with the chord's middle, on the entry's side of the cord, 2 x the envelope half-width there
    # + 0.2 from the cord axis, so the curve clears the torso
    stretch = [(4, 8), (8, 13), (6, 18), (12, 17), (15, 21), (18, 23)]
    src = []
    for p0, (a_, b_) in zip(notes, stretch):
        lines = []
        for kk in (a_, b_):
            p2 = path[idx[min(kk, 23)]]
            mid = (p0 + p2) / 2
            p1 = np.array([-1.0 * (2.0 * float(env_w(mid[1])) + 0.2), mid[1], mid[2]])   # the right side (-X)
            lines.append([scr(p0), scr(p1), scr(p2)])
        src.append(lines)
    anchors["src"] = src
json.dump(anchors, open(OUT.rsplit(".", 1)[0] + ".json", "w"))
print("done", OUT, "frame", anchors["frame"], "brain_top", anchors["brain_top"], "tip", anchors["tip"], "undated_low", anchors["undated_low"], file=sys.stderr)
