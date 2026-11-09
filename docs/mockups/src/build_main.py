"""Builds docs/mockups/main.html: the Cortex main view at 1576x933, dark theme, the figure standing (the default pose).

Hero state (CORTEX-UX section 6.9): one conversation frond selected by double-click. The frond and the notes
built from it stay lit, everything else dims, source lines run from the notes in the brain down to the frond,
the notes' name chips sit in two columns either side of the brain with leaders, the time strip carries a
bracket over the conversation's dates, and the conversation reader is open in the sheet."""
import base64, json, math, random, datetime as dt, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icons import svg

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "main.html")
TOK = open(os.path.join(HERE, "tokens.css"), encoding="utf-8").read()
STAGE_B64 = base64.b64encode(open(os.path.join(HERE, "hero.jpg"), "rb").read()).decode()
A = json.load(open(os.path.join(HERE, "hero.json")))

W, H = 1576, 933
HEADER, STRIP, SHEET = 44, 64, 400
SW = W - SHEET            # stage width with the sheet docked (push mode)
SH = H - HEADER - STRIP   # stage height 825

AREAS = [  # slot order (rank of everything indexed), brain-note counts
    ("Games", 512, 1), ("Vault", 1203, 2), ("Roblox", 988, 3), ("Money", 1021, 4),
    ("Code", 402, 5), ("AI", 214, 6), ("Web", 151, 7), ("Design", 98, 8), ("Other", 117, 0),
]
def col(slot, glow=True):
    return f"var(--cx-cat-{slot}{'-glow' if glow else ''})" if slot else ("var(--cx-cat-other-glow)" if glow else "var(--cx-cat-other)")

# ---------- compass ----------
def compass_svg():
    size, c, ro, ri = 104, 52, 48, 37
    w = [n ** 0.6 for _, n, _ in AREAS]; ws = sum(w)
    a0 = -90.0; parts = []; gap = 1.6
    for (name, n, slot), wi in zip(AREAS, w):
        span = 360 * wi / ws
        s, e = math.radians(a0 + gap / 2), math.radians(a0 + span - gap / 2)
        large = 1 if (span - gap) > 180 else 0
        p = (f"M{c + ro * math.cos(s):.2f} {c + ro * math.sin(s):.2f} A{ro} {ro} 0 {large} 1 {c + ro * math.cos(e):.2f} {c + ro * math.sin(e):.2f} "
             f"L{c + ri * math.cos(e):.2f} {c + ri * math.sin(e):.2f} A{ri} {ri} 0 {large} 0 {c + ri * math.cos(s):.2f} {c + ri * math.sin(s):.2f}Z")
        parts.append(f'<path d="{p}" fill="{col(slot)}" opacity="{0.92 if slot != 0 else 0.7}"><title>{name}</title></path>')
        a0 += span
    hd = math.radians(-90 + A["heading_deg"])   # the needle points at the territory facing the camera (home view: 160 deg)
    tri = [(c + (51.5 + rr) * math.cos(hd + math.radians(da)), c + (51.5 + rr) * math.sin(hd + math.radians(da))) for da, rr in ((0, 0), (-7, 6.5), (7, 6.5))]
    needle = (f'<path d="M{tri[0][0]:.1f} {tri[0][1]:.1f} L{tri[1][0]:.1f} {tri[1][1]:.1f} L{tri[2][0]:.1f} {tri[2][1]:.1f}Z" fill="#eceef2"/>'
              f'<path d="M{c + 33 * math.cos(hd):.1f} {c + 33 * math.sin(hd):.1f} L{c + 30 * math.cos(hd):.1f} {c + 30 * math.sin(hd):.1f}" stroke="#eceef2" stroke-width="1.5" stroke-linecap="round"/>')
    return (f'<svg width="{size + 16}" height="{size + 16}" viewBox="-8 -8 {size + 16} {size + 16}" aria-hidden="true">'
            f'<circle cx="{c}" cy="{c}" r="{ri - 1}" fill="rgba(255,255,255,.025)"/>' + "".join(parts) + needle +
            f'<text x="{c}" y="{c + 2}" text-anchor="middle" class="cmp-n">4,706</text>'
            f'<text x="{c}" y="{c + 15}" text-anchor="middle" class="cmp-u">notes</text></svg>')

# ---------- time strip ----------
def week_series():
    random.seed(4)
    start = dt.date(2023, 2, 6); end = dt.date(2026, 11, 9)
    weeks = []; d = start
    while d <= end:
        weeks.append(d); d += dt.timedelta(days=7)
    vals = []
    for wk in weeks:
        y = wk.year + (wk.timetuple().tm_yday / 366); v = 0.0
        if 2023.1 <= y <= 2025.47:
            base = 180 if y < 2024.6 else 180 * max(0.12, 1 - (y - 2024.6) * 1.1)
            v += max(0, random.gauss(base, base * 0.45)) * (0 if random.random() < 0.08 else 1)
        if y >= 2024.18:
            base = 70 + 90 * min(1, (y - 2024.18) / 1.2)
            v += max(0, random.gauss(base, base * 0.5)) * (0 if random.random() < 0.06 else 1)
        if wk >= dt.date(2026, 9, 28):
            v += random.uniform(6500, 13500)
        vals.append(v)
    s = sum(vals)
    return weeks, [v * 97519 / s for v in vals]

AGE = ["#866fc8", "#5890ec", "#37acc3", "#56c4a7", "#90cf82", "#cdd261", "#e1d6ba", "#f0e0c6"]
def lerp_hex(a, b, t):
    pa = [int(a[i:i + 2], 16) for i in (1, 3, 5)]; pb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(round(x + (y - x) * t) for x, y in zip(pa, pb))
def age_hex(t):
    t = min(max(t, 0), 1) * 7; i = min(int(t), 6)
    return lerp_hex(AGE[i], AGE[i + 1], t - i)

def strip_svg(x0, x1, sel_week):
    weeks, vals = week_series()
    n = len(weeks); bw = (x1 - x0) / n
    cum = 0; tot = sum(vals); mx = math.log1p(max(vals))
    out = []; plot_top, plot_h = 14, 36
    for i, (wk, v) in enumerate(zip(weeks, vals)):
        r = (cum + v / 2) / tot; lin = i / (n - 1); tau = 0.65 * r + 0.35 * lin; cum += v
        h = 0 if v <= 0 else max(1.5, plot_h * math.log1p(v) / mx)
        x = x0 + i * bw
        op = ".92" if wk == sel_week else ".34"   # selection: the conversation's week stays full, the rest dims
        out.append(f'<rect x="{x + 0.5:.2f}" y="{plot_top + plot_h - h:.2f}" width="{max(bw - 1.1, 1):.2f}" height="{h:.2f}" rx="1" fill="{age_hex(tau)}" opacity="{op}"/>')
    lane = []
    note_weeks = {dt.date(2026, 4, 6): 4, dt.date(2026, 4, 13): 3, dt.date(2026, 4, 20): 2, dt.date(2026, 7, 20): 10,
                  dt.date(2026, 8, 3): 1, dt.date(2026, 10, 5): 10, dt.date(2026, 10, 12): 6, dt.date(2026, 10, 19): 7,
                  dt.date(2026, 10, 26): 8, dt.date(2026, 11, 2): 9}
    for i, wk in enumerate(weeks):
        for k, hgt in note_weeks.items():
            if 0 <= (wk - k).days < 7:
                x = x0 + i * bw + bw / 2
                lane.append(f'<rect x="{x - 1:.1f}" y="{6 - min(4, hgt / 2.5):.1f}" width="2" height="{min(4, hgt / 2.5) + 1:.1f}" rx="1" fill="var(--cx-machine)" opacity=".85"/>')
    ticks = []
    for yr in (2024, 2025, 2026):
        i = next(j for j, wk in enumerate(weeks) if wk >= dt.date(yr, 1, 1)); x = x0 + i * bw
        ticks.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{plot_top - 2}" y2="{plot_top + plot_h + 3}" stroke="rgba(255,255,255,.14)" stroke-dasharray="2 3"/>'
                     f'<text x="{x + 4:.1f}" y="61" class="st-t">{yr}</text>')
    ticks.append(f'<text x="{x0 + 2:.1f}" y="61" class="st-t">Feb 2023</text>')
    i = next(j for j, wk in enumerate(weeks) if wk >= dt.date(2026, 7, 1)); x = x0 + i * bw
    ticks.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{plot_top + plot_h}" y2="{plot_top + plot_h + 3}" stroke="rgba(255,255,255,.22)"/><text x="{x + 3:.1f}" y="61" class="st-t st-t2">Jul</text>')
    ticks.append(f'<path d="M{x1 - 4:.1f} 2 L{x1 + 4:.1f} 2 L{x1:.1f} 8Z" fill="var(--cx-stage-text-1)"/><text x="{x1 - 6:.1f}" y="61" text-anchor="end" class="st-t">today</text>')
    hd = ""
    for hx in (x0 - 3, x1 + 3):
        hd += (f'<rect x="{hx - 4:.1f}" y="{plot_top - 4}" width="8" height="{plot_h + 8}" rx="3" fill="#1b1f28" stroke="rgba(255,255,255,.28)"/>'
               f'<line x1="{hx - 1:.1f}" x2="{hx - 1:.1f}" y1="{plot_top + 10}" y2="{plot_top + plot_h - 10}" stroke="rgba(255,255,255,.55)"/>'
               f'<line x1="{hx + 1:.1f}" x2="{hx + 1:.1f}" y1="{plot_top + 10}" y2="{plot_top + plot_h - 10}" stroke="rgba(255,255,255,.55)"/>')
    # bracket over the selected conversation's dates (3-4 Nov): min 14 px wide, centred on its week
    si = weeks.index(sel_week); bx = x0 + si * bw + bw / 2
    bl, br = bx - 7, bx + 7
    lx = bl - 92
    bracket = (f'<path d="M{bl:.1f} 13.5 V9.5 H{br:.1f} V13.5" fill="none" stroke="#eceef2" stroke-width="1.5"/>'
               f'<path d="M{lx + 50:.1f} 6 H{bl - 3:.1f} L{bl:.1f} 9.5" fill="none" stroke="rgba(236,238,242,.55)"/>'
               f'<rect x="{lx:.1f}" y="0.5" width="50" height="12" rx="3" fill="#13161e" stroke="rgba(255,255,255,.24)"/>'
               f'<text x="{lx + 25:.1f}" y="9.6" text-anchor="middle" class="st-b">3–4 Nov</text>')
    return (f'<svg width="{SW}" height="{STRIP}" viewBox="0 0 {SW} {STRIP}" aria-hidden="true" class="st-svg">'
            + "".join(out) + "".join(lane) + "".join(ticks) + hd + bracket + "</svg>")

# ---------- stage overlay: source lines from the lit notes down to the selected frond ----------
NOTES = [  # (kind glyph, kind, title); positions come from hero.json (Roblox wedge, facing the camera)
    ("?", "Question", "Why do items duplicate in trades?"),
    ("◆", "Decision", "Lock slots while the server confirms"),
    ("≡", "Summary", "Inventory duplication on trade"),
    ("▸", "Plan", "Release a held slot after 5 s"),
    ("×", "Abandoned", "Merge stacks on the client"),
    ("✶", "Idea", "Ghost slots for pending trades"),
]
def chip_w(k, t): return 6.05 * len(k + " " + t) + 34          # estimated chip width at 11.5 px
def chip_layout():
    """Label placement for the standing figure (CORTEX-UX section 6.11): chips leave the figure's silhouette to the
    side their note is on and stack in two columns beside the brain, each column ordered by its notes' height, so
    leaders never cross each other or the cord."""
    notes = A["notes"]; bx0, by0, bx1, by1 = A["brain_bbox"]
    order = sorted(range(len(notes)), key=lambda i: notes[i][0])
    left, right = sorted(order[:3], key=lambda i: notes[i][1]), sorted(order[3:], key=lambda i: notes[i][1])
    pos = {}
    top = max(by0 + 4, 96)
    for col, items in (("L", left), ("R", right)):
        for j, i in enumerate(items):
            g, k, t = NOTES[i]
            y = top + j * 40 + (12 if col == "R" else 0)
            x = (bx0 - 46 - chip_w(k, t)) if col == "L" else (bx1 + 46)
            pos[i] = (col, round(x), round(y))
    return pos
CHIPS = chip_layout()
def overlay():
    notes = A["notes"]
    parts = []
    # source lines: each note cites a stretch of the frond; three curves per note, bowed away from the cord axis
    for lines in A["src"]:
        for (p0, p1, p2) in lines:
            parts.append(f'<path d="M{p0[0]:.1f} {p0[1]:.1f} Q{p1[0]:.1f} {p1[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}" stroke="rgba(255,255,255,.34)" stroke-width="1" fill="none"/>'
                         f'<circle cx="{p2[0]:.1f}" cy="{p2[1]:.1f}" r="1.8" fill="#fff" opacity=".85"/>')
    for (nx, ny) in notes:
        parts.append(f'<circle cx="{nx:.1f}" cy="{ny:.1f}" r="6.5" fill="none" stroke="var(--cx-accent)" stroke-width="1.6"/>')
    # leaders from the label chips (inner edge, mid-height) to their notes
    for i, (nx, ny) in enumerate(notes):
        col, x, y = CHIPS[i]; g, k, t = NOTES[i]
        ax = x + chip_w(k, t) if col == "L" else x
        parts.append(f'<path d="M{nx:.1f} {ny:.1f} L{ax:.1f} {y + 10.5:.1f}" stroke="rgba(236,238,242,.42)" stroke-width="1" fill="none"/>')
    # the frond's own label, beyond its outer end
    ex, ey = A["frond"]["end"]
    parts.append(f'<path d="M{ex + 4:.1f} {ey - 2:.1f} L{ex + 34:.1f} {ey - 26:.1f}" stroke="rgba(236,238,242,.42)" stroke-width="1"/>')
    return f'<svg class="cx-ov" width="{SW}" height="{SH}" viewBox="0 0 {SW} {SH}" aria-hidden="true">{"".join(parts)}</svg>'

def chips():
    out = []
    for i, (g, k, t) in enumerate(NOTES):
        col, x, y = CHIPS[i]
        out.append(f'<div class="cx-label" style="left:{x}px;top:{y}px"><i style="background:var(--cx-cat-3-glow)"></i>'
                   f'<span class="g">{g}</span><span class="k">{k}</span>{t}</div>')
    ex, ey = A["frond"]["end"]
    out.append(f'<div class="cx-label fr" style="left:{ex + 34:.0f}px;top:{ey - 37:.0f}px"><i style="background:var(--cx-age-7)"></i>'
               f'<span class="k">Conversation</span>Inventory duplication on trade<span class="n">549</span></div>')
    return "".join(out)

shown = AREAS[:3]     # the key bar is capped at 44% of the stage width so the standing figure's brain clears it
key_chips = "".join(f'<button class="kc" title="{name}: {n:,} notes"><i style="background:{col(slot)}"></i>{name}<b>{n:,}</b></button>' for name, n, slot in shown)
key_chips += '<button class="kc kc-more" title="6 more groups">+6</button>'

# ---------- the conversation reader (sheet) ----------
def quote(sp, text, when):
    mark = '<i class="sp you"></i>' if sp == "you" else '<i class="sp ast"></i>'
    return f'<div class="q">{mark}<span class="qt">“{text}”</span><span class="qw">{when}</span></div>'
def row(g, kind, title, extra="", open_=False):
    chev = svg("chev" if open_ else "chevr", 12)
    return (f'<div class="nr{" open" if open_ else ""}"><span class="kg k-{kind}">{g}</span><span class="nt">{title}</span>'
            f'<span class="nx">{chev}</span></div>{extra}')
SHEET_HTML = f"""
<aside class="sheet" aria-label="Conversation">
  <div class="sh-head">
    <div class="sh-t"><div class="crumb">Roblox inventory sync ›</div><h2>Inventory duplication on trade</h2></div>
    <div class="sh-a"><button class="ib" title="Pin">{svg("pin", 16)}</button><button class="ib" title="Show in brain (F)">{svg("target", 16)}</button>
      <button class="ib" title="More">{svg("more", 16)}</button><button class="ib" title="Close (Esc)">{svg("x", 16)}</button></div>
  </div>
  <div class="facets"><span class="mchip"><b>work</b>debug</span><span class="mchip"><b>outcome</b>shipped</span><span class="mchip"><b>project</b>roblox-inventory</span><span class="mchip"><b>topics</b>trading · inventory</span></div>
  <div class="sh-body">
    <div class="gist"><p>You traced item duplication to two trades resolving in the same frame, locked slots until the server confirms, and gave up on merging stacks on the client.</p>
      <span class="mc">{svg("glyph", 12)}sonnet · 4 Nov</span></div>
    <div class="facts">{svg("msg", 13)}<span>Claude Code</span><span class="mono">549 messages</span><span class="mono">3 Nov 14:05 – 4 Nov 10:12</span><span class="ad"><i style="background:var(--cx-cat-3-glow)"></i>Roblox</span></div>
    <div class="stem">
      <div class="node"><span class="dot"></span><div class="nh"><b>Reproducing the duplication</b><span class="mono">3 Nov 14:05–14:40 · messages 1–38</span></div>
        {row("?", "question", "Why do items duplicate in trades?")}</div>
      <div class="node"><span class="dot"></span><div class="nh"><b>Locking slots while trades confirm</b><span class="mono">14:52–16:30 · messages 39–188</span></div>
        {row("◆", "decision", "Lock slots while the server confirms", quote("you", "can we lock the slot while the server confirms?", "14:52") + quote("ast", "Locking on confirm closes the double-accept window.", "14:53"), open_=True)}
        {row("▸", "plan", "Release a held slot after 5 s")}
        <div class="fix"><span class="fx">{svg("edit", 12)}Your fix</span>The timeout is 5 s, not 30 s<span class="qw">4 Nov</span></div></div>
      <div class="node"><span class="dot"></span><div class="nh"><b>Client-side merging</b><span class="mono">16:41–17:20 · messages 189–301</span></div>
        {row("×", "abandoned", "Merge stacks on the client")}</div>
      <div class="node last"><span class="dot"></span><div class="nh"><b>Ghost slots</b><span class="mono">4 Nov 09:40–10:12 · messages 302–549</span></div>
        {row("✶", "idea", "Ghost slots for pending trades")}</div>
    </div>
    <div class="acts"><button class="btn">{svg("list", 13)}Open conversation</button><button class="btn">{svg("check", 13)}Looks right</button><button class="btn">{svg("edit", 13)}Correct</button></div>
  </div>
</aside>"""

weeks, _ = week_series()
SEL_WEEK = dt.date(2026, 11, 2)

HTML = f"""<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=1576">
<title>Cortex main view</title>
<style>
{TOK}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; background: #000; }}
body {{ width: {W}px; height: {H}px; overflow: hidden; }}
button {{ font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }}
h2, p {{ margin: 0; }}
.cx-root {{ position: relative; width: {W}px; height: {H}px; font-family: var(--cx-font); font-size: var(--cx-fs-md);
  color: var(--cx-text-1); background: var(--cx-stage); -webkit-font-smoothing: antialiased; letter-spacing: 0; }}
.ic {{ flex: none; display: block; }}
.mono {{ font-family: var(--cx-font-mono); font-variant-numeric: tabular-nums; }}

/* header */
.cx-header {{ position: absolute; left: 0; right: 0; top: 0; height: var(--cx-header-h); background: var(--cx-chrome);
  border-bottom: 1px solid var(--cx-line); display: flex; align-items: center; padding: 0 10px 0 14px; gap: 4px; z-index: 20; }}
.cx-brand {{ display: flex; align-items: center; gap: 8px; height: 24px; padding-right: 14px; margin-right: 8px; border-right: 1px solid var(--cx-line); }}
.cx-wordmark {{ font-size: 15px; font-weight: 600; letter-spacing: -.005em; color: var(--cx-text-1); }}
.cx-scope {{ height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 8px 0 7px; border-radius: var(--cx-r-pill);
  background: var(--cx-chrome-alt); border: 1px solid var(--cx-line); color: var(--cx-text-1); margin-right: 10px; }}
.cx-scope .ring {{ width: 14px; height: 14px; border-radius: 50%;
  background: conic-gradient(var(--cx-cat-1-glow) 0 22%, var(--cx-cat-2-glow) 0 44%, var(--cx-cat-3-glow) 0 62%, var(--cx-cat-4-glow) 0 76%, var(--cx-cat-5-glow) 0 86%, var(--cx-cat-7-glow) 0 94%, var(--cx-cat-other-glow) 0 100%);
  -webkit-mask: radial-gradient(circle, transparent 3.2px, #000 3.6px); mask: radial-gradient(circle, transparent 3.2px, #000 3.6px); }}
.cx-scope .ic {{ color: var(--cx-text-3); }}
.cx-tabs {{ display: flex; gap: 2px; }}
.cx-tab {{ height: 28px; padding: 0 10px; border-radius: var(--cx-r-sm); display: flex; align-items: center; gap: 6px; color: var(--cx-text-2); }}
.cx-tab.on {{ background: var(--cx-chrome-active); color: var(--cx-text-1); font-weight: 600; }}
.cx-badge {{ min-width: 18px; height: 17px; padding: 0 5px; border-radius: 9px; background: var(--cx-accent-soft); color: var(--cx-text-1); font: 500 11px/17px var(--cx-font-mono); text-align: center; }}
.cx-dot {{ width: 6px; height: 6px; border-radius: 50%; background: var(--cx-ok); box-shadow: 0 0 0 3px rgba(76,195,138,.18); }}
.cx-hr {{ margin-left: auto; display: flex; align-items: center; gap: 6px; }}
.cx-live {{ display: flex; align-items: center; gap: 7px; color: var(--cx-text-2); font-size: 12px; padding: 0 8px; }}
.cx-agent {{ height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 10px 0 8px; border-radius: var(--cx-r-pill); border: 1px solid var(--cx-line); color: var(--cx-text-1); font-size: 12px; }}
.cx-agent .ic {{ color: var(--cx-accent); }}
.cx-agent small {{ color: var(--cx-text-3); font-size: 12px; }}
.cx-btn {{ height: 28px; display: flex; align-items: center; gap: 6px; padding: 0 11px 0 9px; border-radius: var(--cx-r-sm); border: 1px solid var(--cx-line-strong); color: var(--cx-text-1); font-size: 13px; }}
.cx-ib {{ width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--cx-r-sm); color: var(--cx-text-2); }}
.cx-sep {{ width: 1px; height: 20px; background: var(--cx-line); margin: 0 4px; }}

/* stage */
.cx-stage {{ position: absolute; left: 0; width: {SW}px; top: var(--cx-header-h); height: {SH}px; overflow: hidden; background: var(--cx-stage); }}
.cx-stage > img {{ position: absolute; inset: 0; width: {SW}px; height: {SH}px; display: block; }}
.cx-ov {{ position: absolute; inset: 0; pointer-events: none; }}
.glass {{ background: var(--cx-glass); border: 1px solid var(--cx-glass-line); border-radius: var(--cx-r-md); box-shadow: var(--cx-shadow-glass);
  backdrop-filter: blur(var(--cx-glass-blur)) saturate(1.15); -webkit-backdrop-filter: blur(var(--cx-glass-blur)) saturate(1.15); }}
.cx-key {{ position: absolute; left: var(--cx-inset); top: 12px; max-width: 44%; padding: 5px 6px 5px 10px; display: grid; grid-template-columns: auto 1fr; column-gap: 8px; row-gap: 2px; align-items: center; }}
.cx-key .lab {{ font-size: 12px; color: var(--cx-stage-text-3); display: flex; align-items: center; gap: 6px; height: 28px; }}
.pick {{ height: 24px; display: inline-flex; align-items: center; gap: 4px; padding: 0 6px 0 8px; border-radius: var(--cx-r-sm); background: var(--cx-glass-hover);
  border: 1px solid var(--cx-glass-line); color: var(--cx-stage-text-1); font-size: 12px; }}
.pick .ic {{ color: var(--cx-stage-text-3); }}
.kcs {{ display: flex; align-items: center; gap: 1px; }}
.kc {{ height: 24px; display: flex; align-items: center; gap: 6px; padding: 0 9px 0 8px; border-radius: var(--cx-r-pill); color: var(--cx-stage-text-2); font-size: 12px; white-space: nowrap; }}
.kc i {{ width: 8px; height: 8px; border-radius: 50%; flex: none; }}
.kc b {{ font: 400 11px var(--cx-font-mono); color: var(--cx-stage-text-3); }}
.kc-more {{ border: 1px solid var(--cx-glass-line-strong); padding: 0 8px; font: 11px var(--cx-font-mono); }}
.agebar {{ display: flex; align-items: center; gap: 8px; color: var(--cx-stage-text-3); font: 11px var(--cx-font-mono); padding-left: 8px; white-space: nowrap; }}
.agebar .g {{ width: 96px; height: 6px; border-radius: 3px; background: var(--cx-age-ramp); }}
.agebar .u {{ display: flex; align-items: center; gap: 6px; padding-left: 10px; margin-left: 4px; border-left: 1px solid var(--cx-glass-line); font-family: var(--cx-font); font-size: 12px; color: var(--cx-stage-text-2); }}
.agebar .u i {{ width: 8px; height: 8px; border-radius: 50%; background: var(--cx-undated); }}
.agebar .u b {{ font: 400 11px var(--cx-font-mono); color: var(--cx-stage-text-3); }}
.agebar .lay {{ margin-left: auto; }}
.cx-shape {{ position: absolute; right: var(--cx-inset); top: 12px; height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 4px 0 12px; }}
.cx-shape .end {{ display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--cx-stage-text-1); }}
.cx-shape .end.dim {{ color: var(--cx-stage-text-3); }}
.cx-shape .ic {{ color: var(--cx-stage-text-2); }}
.morph {{ position: relative; width: 132px; height: 20px; }}
.morph .tr {{ position: absolute; left: 0; right: 0; top: 9px; height: 2px; border-radius: 1px; background: linear-gradient(90deg, rgba(255,255,255,.55), rgba(255,255,255,.14)); }}
.morph .tk {{ position: absolute; top: 6px; width: 1px; height: 8px; background: rgba(255,255,255,.22); }}
.morph .th {{ position: absolute; left: -2px; top: 3px; width: 14px; height: 14px; border-radius: 50%; background: #eceef2; box-shadow: 0 0 0 3px rgba(138,92,245,.45), 0 1px 4px rgba(0,0,0,.6); }}
.vsep {{ width: 1px; height: 22px; background: var(--cx-glass-line); }}
.gib {{ width: 28px; height: 28px; display: grid; place-items: center; border-radius: 7px; color: var(--cx-stage-text-2); }}
.cx-tools {{ position: absolute; right: var(--cx-inset); top: 64px; width: 38px; padding: 3px 0; display: flex; flex-direction: column; align-items: center; }}
.tb {{ width: 32px; height: 32px; margin: 1px 0; border-radius: 8px; display: grid; place-items: center; color: var(--cx-stage-text-2); position: relative; }}
.tb.on {{ color: var(--cx-stage-text-1); background: var(--cx-glass-active); }}
.tb.on::after {{ content: ""; position: absolute; right: 3px; top: 3px; width: 5px; height: 5px; border-radius: 50%; background: var(--cx-accent); }}
.tsep {{ width: 22px; height: 1px; background: var(--cx-glass-line); margin: 4px 0; }}
.cx-compass {{ position: absolute; left: var(--cx-inset); bottom: var(--cx-inset); width: 140px; padding: 6px 0 9px; display: flex; flex-direction: column; align-items: center; }}
.cx-compass .cmp-n {{ font: 600 13px var(--cx-font-mono); fill: var(--cx-stage-text-1); }}
.cx-compass .cmp-u {{ font: 10px var(--cx-font); fill: var(--cx-stage-text-3); }}
.cx-compass .cap {{ margin-top: -2px; display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--cx-stage-text-1); }}
.cx-compass .cap .ic {{ color: var(--cx-stage-text-3); }}
.cx-cmd {{ position: absolute; left: calc(50% - var(--cx-cmd-w) / 2); bottom: var(--cx-inset); width: var(--cx-cmd-w); height: var(--cx-cmd-h);
  border-radius: var(--cx-r-lg); display: flex; align-items: center; gap: 8px; padding: 0 8px 0 7px; background: var(--cx-glass-strong); }}
.seg {{ height: 30px; padding: 2px; border-radius: 9px; background: rgba(255,255,255,.05); display: flex; gap: 2px; flex: none; }}
.seg b {{ height: 26px; padding: 0 10px 0 8px; display: flex; align-items: center; gap: 6px; border-radius: 7px; font-size: 12px; font-weight: 500; color: var(--cx-stage-text-3); }}
.seg b.on {{ background: var(--cx-glass-active); color: var(--cx-stage-text-1); box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }}
.tok {{ height: 24px; display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 8px; border-radius: 6px; background: var(--cx-glass-active); font-size: 12px; color: var(--cx-stage-text-1); white-space: nowrap; flex: none; }}
.tok i {{ width: 7px; height: 7px; border-radius: 50%; background: var(--cx-age-7); }}
.tok .ic {{ color: var(--cx-stage-text-3); }}
.cx-cmd .ph {{ flex: 1; font-size: 13px; color: var(--cx-stage-text-3); white-space: nowrap; overflow: hidden; }}
.cx-cmd .ro {{ font: 11px var(--cx-font-mono); color: var(--cx-stage-text-2); white-space: nowrap; }}
.cx-cmd .ro u {{ font-family: var(--cx-font); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(255,255,255,.3); color: var(--cx-stage-text-2); margin-left: 6px; }}
.kbd {{ font: 11px var(--cx-font-mono); color: var(--cx-stage-text-3); border: 1px solid var(--cx-glass-line-strong); border-radius: 4px; padding: 1px 5px; }}
.cx-label {{ position: absolute; height: 21px; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 0; border-radius: var(--cx-r-xs);
  background: rgba(10,12,17,.8); border: 1px solid rgba(255,255,255,.12); font-size: 11.5px; color: var(--cx-stage-text-1); white-space: nowrap; backdrop-filter: blur(6px); }}
.cx-label i {{ width: 3px; align-self: stretch; border-radius: 3px 0 0 3px; }}
.cx-label .g {{ width: 12px; text-align: center; color: var(--cx-stage-text-1); font-family: "Segoe UI Symbol", var(--cx-font); }}
.cx-label .k {{ color: var(--cx-stage-text-3); }}
.cx-label .n {{ font: 11px var(--cx-font-mono); color: var(--cx-stage-text-3); }}
.cx-label.fr {{ padding-left: 0; }}

/* time strip (under the stage only) */
.cx-strip {{ position: absolute; left: 0; width: {SW}px; bottom: 0; height: var(--cx-strip-h); background: var(--cx-strip); border-top: 1px solid var(--cx-glass-line); }}
.st-lead {{ position: absolute; left: 14px; top: 8px; width: 200px; }}
.st-lead .r1 {{ display: flex; align-items: center; gap: 8px; }}
.st-lead .ttl {{ font-size: 12px; font-weight: 600; color: var(--cx-stage-text-1); }}
.st-play {{ width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--cx-glass-line-strong); color: var(--cx-stage-text-2); }}
.st-lead .r2 {{ margin-top: 6px; font: 11px var(--cx-font-mono); color: var(--cx-stage-text-3); }}
.st-svg {{ position: absolute; left: 0; top: 0; overflow: visible; }}
.st-svg .st-t {{ font: 10.5px var(--cx-font-mono); fill: var(--cx-stage-text-3); }}
.st-svg .st-t2 {{ fill: rgba(158,165,177,.75); }}
.st-svg .st-b {{ font: 10px var(--cx-font-mono); fill: #eceef2; }}
.st-notes {{ position: absolute; left: 240px; top: 1px; font-size: 9.5px; line-height: 10px; color: var(--cx-stage-text-3); }}
.st-und {{ position: absolute; right: 14px; top: 13px; }}
.st-und .c {{ height: 22px; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: var(--cx-r-pill); border: 1px solid var(--cx-glass-line-strong); font-size: 12px; color: var(--cx-stage-text-2); }}
.st-und .c i {{ width: 8px; height: 8px; border-radius: 50%; background: var(--cx-undated); }}
.st-und .c b {{ font: 400 11px var(--cx-font-mono); color: var(--cx-stage-text-3); }}

/* sheet: the conversation reader */
.sheet {{ position: absolute; right: 0; top: var(--cx-header-h); width: {SHEET}px; bottom: 0; background: var(--cx-chrome); border-left: 1px solid var(--cx-line); display: flex; flex-direction: column; z-index: 20; }}
.sh-head {{ height: 52px; flex: none; display: flex; align-items: center; gap: 4px; padding: 0 8px 0 14px; }}
.sh-t {{ flex: 1; min-width: 0; }}
.sh-t h2 {{ font-size: 15px; font-weight: 600; color: var(--cx-text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
.crumb {{ font-size: 11px; color: var(--cx-text-3); margin-bottom: 1px; }}
.sh-a {{ display: flex; gap: 2px; }}
.ib {{ width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--cx-r-sm); color: var(--cx-text-2); }}
.facets {{ display: flex; flex-wrap: wrap; gap: 5px; padding: 0 14px 10px; border-bottom: 1px solid var(--cx-line); }}
.mchip {{ height: 22px; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border-radius: var(--cx-r-xs); border: 1px dashed rgba(184,166,255,.55); font-size: 11.5px; color: var(--cx-text-2); }}
.mchip b {{ color: var(--cx-text-3); font-weight: 400; }}
.sh-body {{ flex: 1; overflow: hidden; padding: 14px 20px 20px; position: relative; }}
.gist {{ padding: 2px 0 2px 12px; border-left: 2px dotted var(--cx-machine); }}
.gist p {{ font-size: 13.5px; line-height: 1.55; color: var(--cx-text-1); }}
.mc {{ margin-top: 7px; display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border-radius: 10px; border: 1px dashed rgba(184,166,255,.55); font: 11px var(--cx-font-mono); color: var(--cx-machine); }}
.facts {{ margin-top: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 11.5px; color: var(--cx-text-3); }}
.facts .ic {{ color: var(--cx-text-3); }}
.facts .ad {{ display: inline-flex; align-items: center; gap: 5px; color: var(--cx-text-2); }}
.facts .ad i {{ width: 7px; height: 7px; border-radius: 50%; }}
.stem {{ margin-top: 16px; position: relative; padding-left: 22px; }}
.stem::before {{ content: ""; position: absolute; left: 6px; top: 6px; bottom: 22px; width: 2px; border-radius: 1px; background: linear-gradient(180deg, var(--cx-age-6), var(--cx-age-7)); opacity: .8; }}
.node {{ position: relative; padding-bottom: 12px; }}
.node .dot {{ position: absolute; left: -21px; top: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--cx-chrome); border: 2px solid var(--cx-age-7); }}
.nh {{ display: flex; flex-direction: column; gap: 1px; margin-bottom: 5px; }}
.nh b {{ font-size: 12.5px; font-weight: 600; color: var(--cx-text-1); }}
.nh .mono {{ font-size: 10.5px; color: var(--cx-text-3); }}
.nr {{ display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 6px 0 4px; border-radius: 6px; }}
.nr.open {{ background: rgba(255,255,255,.04); }}
.kg {{ width: 18px; height: 18px; flex: none; border-radius: 4px; display: grid; place-items: center; font: 12px "Segoe UI Symbol", var(--cx-font); color: var(--cx-text-1); border: 1px dashed rgba(184,166,255,.45); }}
.k-question {{ color: var(--cx-cat-1-glow); }} .k-decision {{ color: var(--cx-cat-2-glow); }} .k-plan {{ color: var(--cx-cat-5-glow); }}
.k-abandoned {{ color: var(--cx-cat-6-glow); }} .k-idea {{ color: var(--cx-cat-8-glow); }}
.nt {{ flex: 1; font-size: 12.5px; color: var(--cx-text-1); line-height: 1.3; }}
.nx {{ color: var(--cx-text-3); }}
.q {{ display: flex; align-items: baseline; gap: 8px; padding: 5px 6px 5px 30px; font-size: 12px; line-height: 1.45; color: var(--cx-text-2); }}
.q .sp {{ width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(1px); }}
.q .sp.you {{ background: var(--cx-you); }}
.q .sp.ast {{ border: 1.5px solid var(--cx-assistant); }}
.q .qt {{ flex: 1; }}
.q .qw, .fix .qw {{ font: 10.5px var(--cx-font-mono); color: var(--cx-text-3); margin-left: auto; }}
.fix {{ margin: 4px 0 2px 2px; padding: 5px 8px 5px 10px; border-left: 2px solid var(--cx-you); font-size: 12px; color: var(--cx-text-1); display: flex; gap: 8px; align-items: baseline; }}
.fix .fx {{ display: inline-flex; align-items: center; gap: 4px; color: var(--cx-text-3); font-size: 11px; white-space: nowrap; }}
.acts {{ margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--cx-line); display: flex; gap: 6px; }}
.btn {{ height: 28px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border-radius: var(--cx-r-sm); border: 1px solid var(--cx-line-strong); font-size: 12px; color: var(--cx-text-1); }}
.btn .ic {{ color: var(--cx-text-3); }}
</style></head>
<body>
<div class="cx-root theme-dark" role="application" aria-label="Cortex">
  <header class="cx-header">
    <div class="cx-brand">{svg("glyph", 20)}<span class="cx-wordmark">Cortex</span></div>
    <button class="cx-scope" title="Scope: all areas ([ and ] step)"><span class="ring"></span>All areas{svg("chev", 14)}</button>
    <nav class="cx-tabs" role="tablist" aria-label="Cortex pages">
      <button class="cx-tab on" role="tab" aria-selected="true">Brain</button>
      <button class="cx-tab" role="tab">Read</button>
      <button class="cx-tab" role="tab">Time</button>
      <button class="cx-tab" role="tab">Agents <span class="cx-badge">63</span><span class="cx-dot"></span></button>
      <button class="cx-tab" role="tab">Sources</button>
    </nav>
    <div class="cx-hr">
      <button class="cx-ib" title="Guide (?)">{svg("help", 17)}</button>
      <span class="cx-live"><span class="cx-dot"></span>Live</span>
      <button class="cx-agent" title="566,240 of 1,000,000 tokens used today">{svg("glyph", 15)}Organising<small>3 jobs</small></button>
      <span class="cx-sep"></span>
      <button class="cx-btn">{svg("plus", 15)}Add sources</button>
      <button class="cx-ib" title="Cortex settings">{svg("cog", 17)}</button>
      <button class="cx-ib" title="More">{svg("more", 17)}</button>
    </div>
  </header>

  <main class="cx-stage" aria-label="3D record">
    <img alt="" src="data:image/jpeg;base64,{STAGE_B64}">
    {overlay()}
    {chips()}
    <div class="cx-key glass" aria-label="Key">
      <span class="lab">Brain <button class="pick">Area{svg("chev", 13)}</button></span>
      <div class="kcs">{key_chips}</div>
      <span class="lab">Spine <button class="pick">Age{svg("chev", 13)}</button></span>
      <div class="agebar"><span>Feb 2023</span><span class="g"></span><span>today</span>
        <span class="u"><i></i>Undated<b>41</b></span><button class="pick lay">{svg("layers", 13)}Layers{svg("chev", 13)}</button></div>
    </div>
    <div class="cx-shape glass" aria-label="Shape">
      <span class="end">{svg("body", 17)}Body</span>
      <div class="morph" role="slider" aria-valuenow="0" aria-valuetext="Body"><span class="tr"></span>
        <span class="tk" style="left:33px"></span><span class="tk" style="left:66px"></span><span class="tk" style="left:99px"></span><span class="th"></span></div>
      <span class="end dim">{svg("groups", 16)}Groups</span>
      <span class="vsep"></span>
      <button class="pick">by Area{svg("chev", 13)}</button>
      <button class="gib" title="Shape options: pose, at the core, placement">{svg("more", 15)}</button>
    </div>
    <div class="cx-tools glass" role="toolbar" aria-orientation="vertical">
      <button class="tb" title="Display (O)">{svg("sliders", 17)}</button>
      <button class="tb" title="Chart (C)">{svg("chart", 17)}</button>
      <span class="tsep"></span>
      <button class="tb on" title="Names on the figure · on hover (L)">{svg("tag", 17)}</button>
      <button class="tb" title="Lines (K)">{svg("lines", 17)}</button>
      <button class="tb on" title="Spin (Space)">{svg("turn", 17)}</button>
      <span class="tsep"></span>
      <button class="tb" title="Home view (H)">{svg("home", 17)}</button>
      <button class="tb" title="Immersive (I)">{svg("max", 17)}</button>
    </div>
    <div class="cx-compass glass" aria-label="Area compass">{compass_svg()}<span class="cap">All areas{svg("chev", 12)}</span></div>
    <div class="cx-cmd" role="search">
      <div class="seg" role="tablist"><b class="on">{svg("search", 14)}Find</b><b>{svg("glyph", 14)}Ask</b></div>
      <span class="tok"><i></i>Conversation: Inventory duplication…{svg("x", 13)}</span>
      <span class="ph">Find anything in your record</span>
      <span class="ro">549 traced<u>Clear</u></span>
      <span class="kbd">Ctrl K</span>
    </div>
  </main>

  <footer class="cx-strip" aria-label="Time strip">
    {strip_svg(236, SW - 146, SEL_WEEK)}
    <span class="st-notes">notes</span>
    <div class="st-lead">
      <div class="r1"><button class="st-play" title="Replay growth">{svg("play", 12)}</button><span class="ttl">Time</span><button class="pick">All time{svg("chev", 13)}</button></div>
      <div class="r2">97,519 entries · 4,706 notes</div>
    </div>
    <div class="st-und"><span class="c"><i></i>Undated<b>41</b></span></div>
  </footer>
  {SHEET_HTML}
</div>
</body></html>
"""
open(OUT, "w", encoding="utf-8").write(HTML)
print("wrote", OUT, len(HTML))
