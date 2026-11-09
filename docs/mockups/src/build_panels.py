"""Builds docs/mockups/panels.html: readers, pages, Ask, Display and the first-run flow at real size, dark theme.

Row 1: entry reader, map reader, Time, Agents, Read (sheets, 400 x 889).
Row 2: Ask with a thread and changes, Ask empty state with slash commands (each console rises from the command
line at the stage's bottom, with the standing figure's brain and shoulders above it), Display popover and Layers menu.
Row 3: the empty stage with the first-run checklist over the standing haze silhouette, and the first-run step of
Add sources."""
import base64, os, sys, math, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icons import svg

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "panels.html")
TOK = open(os.path.join(HERE, "tokens.css"), encoding="utf-8").read()
STAGE_B64 = base64.b64encode(open(os.path.join(HERE, "stage.jpg"), "rb").read()).decode()
HAZE_B64 = base64.b64encode(open(os.path.join(HERE, "haze.jpg"), "rb").read()).decode()
PW, PH = 2160, 2620

FILL = ["#5293ed", "#cd8000", "#d35e9a", "#9d9900", "#00a0ad", "#d95833", "#9875e3", "#09a773"]
GLOW = ["#7ab9fd", "#deb125", "#f58ebc", "#cbd871", "#2eeafd", "#e6ac86", "#c4a9ff", "#6ad39a"]
OTHER_FILL, NONE_FILL = "#7b90a5", "#66686f"
YOU, AST = "#deb125", "#c4a9ff"           # speaker glow colours (slot 2 amber, slot 7 violet)
YOU_F, AST_F = "#cd8000", "#9875e3"       # their fill variants for 2D marks on chrome
AGE = ["#866fc8", "#5890ec", "#37acc3", "#56c4a7", "#90cf82", "#cdd261", "#e1d6ba", "#f0e0c6"]
COUNT = ["#1e2b38", "#1e2c3f", "#004568", "#265d8e", "#3d6dc3", "#5692ec", "#73b2f8", "#abcffe"]

def lerp_hex(a, b, t):
    pa = [int(a[i:i + 2], 16) for i in (1, 3, 5)]; pb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(round(x + (y - x) * t) for x, y in zip(pa, pb))
def age_hex(t):
    t = min(max(t, 0), 1) * 7; i = min(int(t), 6)
    return lerp_hex(AGE[i], AGE[i + 1], t - i)

def sheet_head(title, crumb=None, icons=(), back=False, extra=""):
    b = f'<button class="ib" title="Back (Alt+Left)">{svg("back", 16)}</button>' if back else ""
    c = f'<div class="crumb">{crumb}</div>' if crumb else ""
    ic = "".join(f'<button class="ib" title="{t}">{svg(n, 16)}</button>' for n, t in icons)
    return (f'<div class="sh-head">{b}<div class="sh-t">{c}<h2>{title}</h2></div>{extra}<div class="sh-a">{ic}'
            f'<button class="ib" title="Close (Esc)">{svg("x", 16)}</button></div></div>')

# ---------------------------------------------------------------- entry reader
def scrubber(w=360, n=549, cur=38):
    random.seed(21)
    out = []; bw = w / n
    for i in range(n):
        r = random.random()
        c = YOU if (i % 7 in (0, 3) and r < .9) else (AST if r < .86 else NONE_FILL)
        h = 10 if c != NONE_FILL else 6
        out.append(f'<rect x="{i * bw:.2f}" y="{14 - h}" width="{max(bw - .15, .4):.2f}" height="{h}" fill="{c}" opacity=".85"/>')
    x = cur * bw
    out.append(f'<rect x="{x - 1:.1f}" y="0" width="2.4" height="18" rx="1" fill="#fff"/><path d="M{x - 4:.1f} 22 L{x + 4:.1f} 22 L{x:.1f} 18Z" fill="#fff"/>')
    for part in (38, 188, 301):   # part boundaries
        out.append(f'<rect x="{part * bw:.1f}" y="15.5" width="1" height="3" fill="rgba(255,255,255,.45)"/>')
    return f'<svg width="{w}" height="24" viewBox="0 0 {w} 24">{"".join(out)}</svg>'

ENTRY = f"""
<section class="sheet" aria-label="Message">
  {sheet_head("Message", "Inventory duplication on trade ›", (("pin", "Pin"), ("target", "Show in brain (F)"), ("more", "More")), back=True)}
  <div class="sh-body">
    <dl class="factsg">
      <dt>Speaker</dt><dd><i class="sp you"></i>You</dd>
      <dt>Source</dt><dd>{svg("msg", 12)}Claude Code</dd>
      <dt>Project</dt><dd>roblox-inventory</dd>
      <dt>Area</dt><dd><i class="ad" style="background:{GLOW[2]}"></i>Roblox</dd>
      <dt>Written</dt><dd class="w mono">3 Nov 2026, 14:52</dd>
      <dt>Imported</dt><dd class="w mono">3 Nov 2026, 15:10</dd>
      <dt>Date</dt><dd class="w"><span class="conf">Strong</span><u>How this date is known</u></dd>
    </dl>
    <h1 class="rd-title">Can we lock the slot while the server confirms the trade?</h1>
    <div class="verb">
      <p>ok so the duplication only happens when two trades resolve in the same frame. I can reproduce it every time by double-clicking accept.</p>
      <p>can we lock the slot while the server confirms? and if the confirm never comes back, release it after a few seconds instead of leaving it stuck</p>
    </div>
    <div class="scrub"><div class="sc-h"><span>In this conversation</span><span class="mono">39 / 549</span></div>{scrubber()}
      <div class="sc-k"><span><i class="sp you"></i>you</span><span><i class="sp ast"></i>assistant</span><span><i class="sq"></i>tool</span><span class="r">{svg("list", 12)}Open conversation</span></div></div>
    <div class="sec"><div class="sec-h"><h3>Labels</h3><span class="lk">Correct</span></div>
      <div class="chips"><span class="mchip"><b>work</b>debug</span><span class="mchip"><b>outcome</b>shipped</span><span class="mchip"><b>project</b>roblox-inventory</span><button class="uchip">{svg("plus", 11)}Add label</button></div>
      <div class="mnote">{svg("glyph", 12)}From its conversation · haiku · session 1.0.0 · 3 Nov</div></div>
    <div class="sec"><div class="sec-h"><h3>Notes that cite this</h3><span class="r">3</span></div>
      <div class="rows">
        <div class="row"><span class="kg k2">◆</span><div class="tx"><div class="t1">Lock slots while the server confirms</div><div class="t2">Decision · sonnet · 3 Nov</div></div></div>
        <div class="row"><span class="kg k1">?</span><div class="tx"><div class="t1">Why do items duplicate in trades?</div><div class="t2">Question · sonnet · 3 Nov</div></div></div>
        <div class="row"><span class="kg km">✦</span><div class="tx"><div class="t1">Roblox inventory sync</div><div class="t2">Project map · 26 notes</div></div></div>
      </div></div>
    <div class="sec"><div class="sec-h"><h3>Related</h3></div>
      <div class="terms"><span class="term on">trade <b>4</b></span><span class="term">slot <b>2</b></span><span class="term">confirm <b>2</b></span></div>
      <div class="rows">
        <div class="row"><span class="mk"><i class="sp you"></i></span><div class="tx"><div class="t1">Trade window grid pass</div><div class="t2">28 Oct · Claude Code</div></div></div>
        <div class="row"><span class="mk"><i class="sp ast"></i></span><div class="tx"><div class="t1">Here's a lock-and-release pattern for pending trades…</div><div class="t2">3 Nov · next message</div></div></div>
      </div></div>
    <div class="sec"><div class="sec-h"><h3>History</h3></div>
      <ol class="hist">
        <li><i class="hd"></i><span>Imported from Claude Code</span><b>3 Nov 15:10</b></li>
        <li><i class="hd m"></i><span>Labelled by haiku · session 1.0.0</span><b>3 Nov 15:41</b></li>
        <li><i class="hd m"></i><span>Cited by sonnet in a summary</span><b>4 Nov 09:12</b></li>
        <li><i class="hd y"></i><span>Version 2 by you · fixed a typo · <u>diff</u></span><b>5 Nov 10:30</b></li>
        <li><i class="hd m"></i><span>Read by sonnet for an Ask answer</span><b>6 Nov 11:02</b></li>
      </ol></div>
  </div>
</section>"""

# ---------------------------------------------------------------- map reader
def sparkline(w=96, h=20):
    vals = [0, 1, 0, 2, 1, 3, 2, 4, 6, 9, 12, 8]
    bw = w / 12; mx = max(vals)
    return (f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">' +
            "".join(f'<rect x="{i * bw + .5:.1f}" y="{h - max(1, h * v / mx):.1f}" width="{bw - 1.6:.1f}" height="{max(1, h * v / mx):.1f}" rx="1" fill="{GLOW[2]}" opacity="{.45 + .55 * (i / 11):.2f}"/>' for i, v in enumerate(vals)) + "</svg>")
def meter(y, a):
    m = max(y, a, 1)
    return (f'<span class="em" title="{y} quotes from you, {a} from the assistant"><span class="b"><i style="width:{22 * y / 4:.0f}px;background:{YOU}"></i></span>'
            f'<span class="b"><i style="width:{22 * a / 4:.0f}px;background:{AST}"></i></span></span>')
MAP = f"""
<section class="sheet" aria-label="Map">
  {sheet_head("Roblox inventory sync", "Roblox ›", (("flag", "Flag something wrong or missing"), ("pin", "Pin"), ("target", "Show in brain (F)"), ("more", "More")), back=True)}
  <div class="sh-body">
    <div class="mapk"><span class="kg km">✦</span><span>Project map</span>{sparkline()}<span class="mono dim">last 12 weeks</span></div>
    <div class="brief">
      <div class="bl">{meter(3, 2)}<span>Slots lock while the server confirms a trade.</span></div>
      <div class="bl">{meter(2, 1)}<span>A held slot is released after 5 seconds.</span></div>
      <div class="bl">{meter(1, 3)}<span>Merging stacks on the client was abandoned.</span></div>
      <div class="bl">{meter(0, 2)}<span>Ghost slots for pending trades are still an idea.</span></div>
      <span class="mc">{svg("glyph", 12)}sonnet · refreshed 8 Nov</span>
    </div>
    <div class="kinds"><b class="on">All 26</b><b>Decisions 8</b><b>Questions 7</b><b>Plans 4</b><b>Ideas 5</b><b>Abandoned 2</b></div>
    <div class="grp"><div class="gh"><span class="kg k2">◆</span>Decisions<b>8</b></div>
      <div class="nr open"><span class="nt">Lock slots while the server confirms</span><span class="nd mono">3 Nov</span>{svg("chev", 12)}</div>
      <div class="q"><i class="sp you"></i><span class="qt">“can we lock the slot while the server confirms?”</span><span class="qw">3 Nov</span></div>
      <div class="q"><i class="sp ast"></i><span class="qt">“Locking on confirm closes the double-accept window.”</span><span class="qw">3 Nov</span></div>
      <div class="nr"><span class="nt">Keep one profile store per player</span><span class="nd mono">29 Oct</span>{svg("chevr", 12)}</div>
      <div class="nr"><span class="nt">Trades settle on the server only</span><span class="nd mono">22 Oct</span>{svg("chevr", 12)}</div>
      <div class="more">+5 more</div></div>
    <div class="grp"><div class="gh"><span class="kg k1">?</span>Questions<b>7</b></div>
      <div class="nr"><span class="nt">Why do items duplicate in trades?</span><span class="nd mono">3 Nov</span>{svg("chevr", 12)}</div>
      <div class="nr"><span class="nt">Does the confirm survive a server hop?</span><span class="nd mono">4 Nov</span>{svg("chevr", 12)}</div>
      <div class="more">+5 more</div></div>
    <div class="grp"><div class="gh"><span class="kg k5">▸</span>Plans<b>4</b></div>
      <div class="nr"><span class="nt">Release a held slot after 5 s</span><span class="nd mono">4 Nov</span>{svg("chevr", 12)}</div></div>
    <div class="mfoot"><span class="mono">26 notes · 1,204 sources</span><span class="lk">Trace all sources</span></div>
  </div>
</section>"""

# ---------------------------------------------------------------- Time: the spine laid flat
def rhythm_grid():
    random.seed(12)
    cell, gap = 8, 2; out = []
    for d in range(7):
        for h in range(24):
            base = (0.15 if h < 7 else 0.5 + 0.5 * math.sin((h - 8) / 15 * math.pi)) * (0.75 if d >= 5 else 1)
            if 19 <= h <= 23: base += 0.45
            v = min(1, max(0, base + random.uniform(-.2, .2)))
            lvl = 0 if v < .12 else min(7, 1 + int(v * 7))
            out.append(f'<rect x="{30 + h * (cell + gap)}" y="{d * (cell + gap)}" width="{cell}" height="{cell}" rx="1.5" fill="{COUNT[lvl]}"/>')
    for d, lab in ((0, "Mon"), (2, "Wed"), (4, "Fri"), (6, "Sun")):
        out.append(f'<text x="0" y="{d * (cell + gap) + 7.5}" class="ax">{lab}</text>')
    for h in (0, 6, 12, 18, 23):
        out.append(f'<text x="{30 + h * (cell + gap)}" y="{7 * (cell + gap) + 9}" class="ax">{h:02d}</text>')
    return f'<svg width="{30 + 24 * (cell + gap)}" height="{7 * (cell + gap) + 12}">{"".join(out)}</svg>'

def spine_figure(w=360):
    random.seed(31)
    H_YOU, AXIS, H_AST, FR = 64, 82, 64, 70
    top = 18; ay = top + H_YOU; fy = ay + H_AST + 16
    n = 120; xs = [i / (n - 1) for i in range(n)]
    def env(x, k):
        late = 1 / (1 + math.exp(-(x - 0.82) * 22))
        return (0.18 + 0.25 * math.sin(x * 9 + k) ** 2 + 0.55 * late) * (0.8 + 0.4 * random.random())
    you = [env(x, 0.3) * (0.55 + 0.25 * x) for x in xs]; ast = [env(x, 1.1) for x in xs]
    mx = max(max(you), max(ast))
    def area(vals, sign, hh):
        pts = [f"{x * w:.1f},{ay - sign * hh * v / mx:.1f}" for x, v in zip(xs, vals)]
        return f"M0,{ay} L" + " L".join(pts) + f" L{w},{ay} Z"
    out = []
    # brush: period 2 Oct - today (spine positions 0.80 - 0.94 of 0.06..0.94)
    bx0, bx1 = w * (0.80 - 0.06) / 0.88, w
    out.append(f'<rect x="0" y="{top - 6}" width="{bx0:.1f}" height="{fy + FR - top + 6}" fill="rgba(28,28,28,.55)"/>')
    out.append(f'<path d="{area(you, 1, H_YOU)}" fill="{YOU_F}" opacity=".55"/><path d="{area(ast, -1, H_AST)}" fill="{AST_F}" opacity=".5"/>')
    out.append(f'<path d="M0 {ay - H_YOU * you[0] / mx:.1f} ' + " ".join(f"L{x * w:.1f} {ay - H_YOU * v / mx:.1f}" for x, v in zip(xs, you)) + f'" fill="none" stroke="{YOU}" stroke-width="1"/>')
    out.append(f'<path d="M0 {ay + H_AST * ast[0] / mx:.1f} ' + " ".join(f"L{x * w:.1f} {ay + H_AST * v / mx:.1f}" for x, v in zip(xs, ast)) + f'" fill="none" stroke="{AST}" stroke-width="1"/>')
    # the cord: age gradient
    out.append('<defs><linearGradient id="ag" x1="0" x2="1">' + "".join(f'<stop offset="{i / 7:.3f}" stop-color="{c}"/>' for i, c in enumerate(AGE)) + '</linearGradient></defs>')
    out.append(f'<rect x="0" y="{ay - 1.5}" width="{w}" height="3" rx="1.5" fill="url(#ag)"/>')
    # kind glyphs riding the axis
    glyphs = [("◆", GLOW[1]), ("?", GLOW[0]), ("▸", GLOW[4]), ("×", GLOW[5])]
    for k in range(34):
        x = w * (0.35 + 0.65 * random.random() ** 0.6)
        g, c = random.choice(glyphs)
        out.append(f'<text x="{x:.1f}" y="{ay + 4:.1f}" text-anchor="middle" class="kgl" fill="{c}">{g}</text>')
    # fronds: one tick per conversation, length ~ log messages, colour = area
    areas = [FILL[2]] * 5 + [FILL[1], FILL[0], FILL[3], FILL[4], FILL[6], OTHER_FILL]
    for k in range(260):
        x = w * (random.random() ** 0.55)
        msgs = int(math.exp(random.uniform(1, 6.3)))
        L = 6 + 9 * math.log1p(msgs / 10)
        out.append(f'<rect x="{x:.1f}" y="{fy}" width="1" height="{min(FR, L):.1f}" fill="{random.choice(areas)}" opacity=".8"/>')
    sx = w * (0.8464 - 0.06) / 0.88   # the selected conversation from main.png
    out.append(f'<rect x="{sx - .5:.1f}" y="{fy - 2}" width="2" height="{FR}" fill="#fff"/>')
    out.append(f'<text x="{sx - 4:.1f}" y="{fy + FR + 11}" text-anchor="end" class="ax hi">549</text>')
    # brush handles
    for hx in (bx0,):
        out.append(f'<rect x="{hx - 4:.1f}" y="{top - 6}" width="8" height="{fy + FR - top + 6}" rx="3" fill="#1b1f28" stroke="rgba(255,255,255,.35)"/>')
    # axis labels: spine scale (rank-warped), same tau as the 3D cord
    for frac, lab in ((0.0, "Feb 2023"), (0.205, "2024"), (0.39, "2025"), (0.565, "2026"), (0.79, "Oct"), (0.985, "today")):
        anchor = "end" if lab == "today" else "start"
        out.append(f'<line x1="{frac * w:.1f}" x2="{frac * w:.1f}" y1="{ay + 3}" y2="{ay + 7}" stroke="rgba(255,255,255,.3)"/>'
                   f'<text x="{frac * w + (0 if anchor == "end" else 2):.1f}" y="{fy + FR + 24}" text-anchor="{anchor}" class="ax">{lab}</text>')
    out.append(f'<text x="2" y="{top + 2}" class="lane you">yours: 31% of words, rising</text>')
    out.append(f'<text x="2" y="{ay + H_AST + 2}" class="lane ast">assistant</text>')
    out.append(f'<text x="2" y="{fy + FR - 2}" class="lane">conversations</text>')
    out.append(f'<text x="{bx0 - 7:.1f}" y="{top - 9}" text-anchor="end" class="ax hi">period: 2 Oct – today</text>')
    return f'<svg width="{w}" height="{fy + FR + 30}" viewBox="0 {top - 16} {w} {fy + FR + 46 - top}">{"".join(out)}</svg>'

SN = {'duplication': 'ok so the duplication only happens when two trades resolve in the same frame', 'grid': 'the grid needs to snap to slot size before the confirm animation', 'profile': 'move every player to one profile store and drop the legacy keys', 'palette': 'check every shipped stop against the colours sampled from the recordings', 'agents': 'rewrite the Agents subtitle so it says what changed', 'onedrive': 'what happens to a ledger when OneDrive makes a conflict copy', 'ghost': 'what if a pending trade showed a ghost of the item in both inventories', 'bench': 'benchmark the profile store with 200 concurrent saves', 'takeout': 'Takeout keeps My Activity as one file per product'}
def convo_row(title, when, you, src="msg", area=GLOW[2], n=None):
    return (f'<div class="lrow"><span class="split"><i style="height:{you}%;background:{YOU}"></i><i style="height:{100 - you}%;background:{AST}"></i></span>'
            f'<div class="tx"><div class="t1">{title}</div><div class="t2 snip">{svg(src, 11)}<i class="ad" style="background:{area}"></i><span>{n or ""}</span></div></div><span class="when">{when}</span></div>')

TIME = f"""
<section class="sheet" aria-label="Time">
  {sheet_head("Time", None, (("image", "Save image…"), ("more", "More")), extra='<div class="segc sm"><b class="on">Figure</b><b>Data</b></div>')}
  <div class="sh-body">
    <p class="sub">Your spine, laid flat. Drag across it to set the period.</p>
    <div class="rhythm"><div class="sec-h"><h3>Rhythm</h3><span class="r">weekday × hour · this period</span></div>{rhythm_grid()}</div>
    <div class="sec"><div class="sec-h"><h3>Spine</h3><span class="r rt"><span class="tg mini"></span>Hide No area</span></div>{spine_figure()}
      <div class="lg"><span><b class="g" style="color:{GLOW[1]}">◆</b>decision</span><span><b class="g" style="color:{GLOW[0]}">?</b>question</span><span><b class="g" style="color:{GLOW[4]}">▸</b>plan</span><span><b class="g" style="color:{GLOW[5]}">×</b>abandoned</span><span class="dim">spine scale: busy weeks get more room</span></div></div>
    <div class="sec"><div class="sec-h"><h3>Longest conversations in this period</h3><span class="r">1,184</span></div>
      {convo_row("Inventory duplication on trade", "6 d", 34, n=SN["duplication"])}
      {convo_row("Trade window grid pass", "12 d", 41, n=SN["grid"])}
      {convo_row("Profile store migration", "3 w", 28, area=GLOW[1], n=SN["profile"])}
      {convo_row("Cortex palette originality check", "today", 46, area=GLOW[4], n=SN["palette"])}
    </div>
  </div>
</section>"""

# ---------------------------------------------------------------- Agents
def spend_chart(w=360, h=70):
    vals = [0.42, 0.61, 0.38, 0.95, 1.0, 0.72, 0.55, 0.33, 0.88, 0.91, 0.47, 0.64, 0.79, 0.57]
    bw = w / 14; out = []; top = 14
    for i, v in enumerate(vals):
        hh = (h - 14 - top) * v
        c = "var(--cx-serious)" if v >= 1.0 else ("#5692ec" if i < 13 else "#abcffe")
        out.append(f'<rect x="{i * bw + 2:.1f}" y="{h - 14 - hh:.1f}" width="{bw - 5:.1f}" height="{hh:.1f}" rx="2" fill="{c}"/>')
    out.append(f'<line x1="0" x2="{w}" y1="{top + .5}" y2="{top + .5}" stroke="rgba(255,255,255,.35)" stroke-dasharray="4 3"/>')
    out.append(f'<text x="{w}" y="{top - 4}" text-anchor="end" class="ax">daily cap 1,000,000</text>')
    out.append(f'<text x="0" y="{h}" class="ax">27 Oct</text><text x="{w}" y="{h}" text-anchor="end" class="ax">today</text>')
    return f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">{"".join(out)}</svg>'
def srcbar(name, done, wait, chk, total):
    t = done + wait + chk
    return (f'<div class="sb"><span class="sbn">{name}</span><span class="sbb"><i style="width:{100 * chk / t:.1f}%;background:var(--cx-ok)"></i>'
            f'<i style="width:{100 * done / t:.1f}%;background:#5692ec"></i><i style="width:{100 * wait / t:.1f}%;background:rgba(255,255,255,.12)"></i></span><span class="mono sbt">{total}</span></div>')
AGENTS = f"""
<section class="sheet" aria-label="Agents">
  {sheet_head("Agents", None, (("drop", "Export ledger"), ("more", "More")))}
  <div class="sh-body">
    <div class="segc" style="display:flex"><b class="on">Ledger</b><b>Checks <span class="bdg">63</span></b><b>Access log</b></div>
    <p class="sub" style="margin-top:10px">Model runs, their cost in tokens, and what they changed.</p>
    <div class="card" style="margin-top:10px">
      <div class="ag-st"><span class="spin">{svg("glyph", 16)}</span><div><h4>Organising</h4><p>3 jobs · label, summary, summary</p></div>
        <div class="ag-btns"><button class="btn">{svg("pause", 13)}Pause</button></div></div>
      <div class="eng"><b>Claude Code CLI</b>, headless, no tools. Labels with <b>haiku</b>, summaries with <b>sonnet</b>, maps with <b>opus</b>. Signed in through Claude Code; Cortex stores no key.</div>
    </div>
    <div class="sec"><div class="sec-h"><h3>Today</h3><span class="r">resets at midnight</span></div>
      <div class="big"><span class="n">566,240</span><span class="u">of 1,000,000 tokens</span></div>
      <div class="meter"><i style="width:56.6%;background:linear-gradient(90deg,#3d6dc3,#73b2f8)"></i></div>
      <div class="mt"><span>57% of today's cap</span><span>≈ 5 h of work left at this pace</span></div></div>
    <div class="sec"><div class="sec-h"><h3>Work waiting</h3><span class="r">since 9 Oct</span></div>
      <div class="wq"><span>Label <b class="mono">1,284</b> conversations</span><span>Summaries <b class="mono">46</b></span><span>Your checks <b class="mono">63</b></span></div>
      {srcbar("Claude Code", 260, 98, 23, "381")}{srcbar("ChatGPT", 410, 1028, 12, "1,450")}{srcbar("Claude.ai", 640, 158, 28, "826")}{srcbar("Vault notes", 1700, 0, 0, "1,700")}
      <div class="sbk"><span><i style="background:var(--cx-ok)"></i>checked by you</span><span><i style="background:#5692ec"></i>done</span><span><i style="background:rgba(255,255,255,.18)"></i>waiting</span></div></div>
    <div class="sec"><div class="sec-h"><h3>Recent runs</h3><span class="lk">All 1,317</span></div>
      <table class="tbl"><colgroup><col style="width:48px"><col><col style="width:66px"><col style="width:58px"></colgroup>
      <tr><th>Time</th><th>Job · model</th><th class="n">Tokens</th><th style="padding-left:10px">Result</th></tr>
      <tr><td class="mono">14:22</td><td>{svg("chev", 11)}label · haiku</td><td class="n">31,204</td><td style="padding-left:10px"><span class="stc"><i style="background:var(--cx-ok)"></i>done</span></td></tr>
      <tr class="det"><td></td><td colspan="3"><div class="rf"><span>Items<b>24</b></span><span>Labels<b>186</b></span><span>Declined<b>2</b></span><span>No answer<b>5</b></span></div></td></tr>
      <tr><td class="mono">14:19</td><td>{svg("chevr", 11)}summary · sonnet</td><td class="n">48,911</td><td style="padding-left:10px"><span class="stc"><i style="background:var(--cx-ok)"></i>done</span></td></tr></table></div>
    <div class="sec"><div class="sec-h"><h3>Label packs</h3><span class="r rt"><span class="tg mini"></span>Include superseded labels</span></div>
      <table class="tbl"><tr><th>Pack</th><th class="n">Labels</th><th class="n">Items</th><th class="n">Blank</th></tr>
      <tr><td>{svg("chev", 11)}session 1.0.0</td><td class="n">5,318</td><td class="n">1,329</td><td class="n">41</td></tr>
      <tr class="sub"><td>work</td><td class="n">1,329</td><td class="n">97%</td><td class="n">12</td></tr>
      <tr class="sub"><td>outcome</td><td class="n">1,329</td><td class="n">95%</td><td class="n">29</td></tr>
      <tr><td>{svg("chevr", 11)}placement 1.0.0</td><td class="n">1,702</td><td class="n">1,702</td><td class="n">0</td></tr></table></div>
    <div class="sec"><div class="sec-h"><h3>Last 14 days</h3><span class="r">tokens per day</span></div>{spend_chart()}</div>
  </div>
</section>"""

# ---------------------------------------------------------------- Read
READ = f"""
<section class="sheet" aria-label="Read">
  {sheet_head("Read", None, (("more", "More"),), extra=f'<button class="nbtn">{svg("pen", 13)}New entry</button>')}
  <div class="sh-body">
    <div class="field">{svg("search", 14)}<span>Filter this list</span><span class="tr"><span class="tg mini on"></span>Trace results on the figure</span></div>
    <div class="rdr"><div class="segc" style="display:flex;flex:1"><b class="on">By date</b><b>By folder</b><b>By source</b></div>
      <button class="tgb" title="Pinned only">{svg("pin", 14)}</button><button class="tgb on" title="Today">{svg("sun", 14)}</button></div>
    <div class="preset"><b>Today</b><span>Monday 9 November</span><span class="lk">Open today's daily note</span></div>
    <div class="dayh">Today</div>
    {convo_row("Cortex palette originality check", "2 h", 46, area=GLOW[4], n=SN["palette"])}
    {convo_row("Agents page copy pass", "5 h", 52, area=GLOW[4], n=SN["agents"])}
    {convo_row("Quick: OneDrive conflict copies", "7 h", 61, area=GLOW[6], n=SN["onedrive"])}
    <div class="dayh">Yesterday</div>
    {convo_row("Ghost slots for pending trades", "1 d", 38, n=SN["ghost"])}
    {convo_row("Lua profile store benchmarks", "1 d", 30, area=GLOW[1], n=SN["bench"])}
    {convo_row("Notes on the Takeout export", "1 d", 100, src="file", area=GLOW[0], n=SN["takeout"])}
    <div class="dayh">This week</div>
    {convo_row("Inventory duplication on trade", "6 d", 34, n=SN["duplication"])}
    {convo_row("Trade window grid pass", "7 d", 41, n=SN["grid"])}
  </div>
</section>"""

# ---------------------------------------------------------------- Ask: thread with changes
ASK_THREAD = f"""
<div class="console" style="left:30px;bottom:16px">
  <div class="co-h">{svg("glyph", 16)}<h3>Ask</h3><span class="eng2">Claude Code · sonnet · answers only from your record</span>
    <button class="gib" title="Change history">{svg("history", 15)}</button><button class="gib" title="Keep open">{svg("pin", 15)}</button><button class="gib" title="Collapse">{svg("chev", 15)}</button></div>
  <div class="co-b">
    <div class="msg-you">show me everything about the trade duplication bug from last week</div>
    <div class="msg-cx"><span class="av">{svg("glyph", 14)}</span><div>I traced <b>214 entries and 9 notes</b> about the duplication bug, 2–8 Nov 2026. Almost all of it is one Claude Code conversation, “Inventory duplication on trade” <span class="cite">1</span>, where you settled on locking slots during confirmation on 3 Nov <span class="cite">2</span>.</div></div>
    <div class="rcpt"><span class="ok">{svg("check", 12)}</span><span class="w">Traced 214 entries and 9 notes<small>2–8 Nov 2026</small></span><button class="u">{svg("undo", 13)}Undo change</button></div>
    <div class="rcpt"><span class="ok">{svg("check", 12)}</span><span class="w">Set the period<small>2–8 Nov 2026</small></span><button class="u">{svg("undo", 13)}Undo change</button></div>
    <div class="msg-you"><span class="slash">/merge</span> inv-sync into roblox-inventory</div>
    <div class="prop"><h5>{svg("branch", 15)}Combine two projects</h5>
      <p><b>inv-sync</b> (12 conversations) into <b>roblox-inventory</b> (26). They show as one group everywhere; no file moves. Saved as your fix, so the agents keep it.</p>
      <p class="why">{svg("glyph", 12)}The AI's reason: “They share 31 conversations.”</p>
      <div class="acts"><button class="gbtn pri">{svg("check", 13)}Apply</button><button class="gbtn">Cancel</button><small>Enter applies · Esc cancels</small></div></div>
  </div>
  <div class="co-in"><div class="seg2"><b>{svg("search", 14)}Find</b><b class="on">{svg("glyph", 14)}Ask</b></div>
    <span class="tx">Ask a question, or type / for an action<span class="caret"></span></span><span class="kbd">Enter</span></div>
</div>"""

SLASH = [("/trace", "Trace everything that matches", "/trace trade duplication"), ("/chart", "Arrange the figure as a chart", "/chart calendar by source"),
         ("/arrange", "Pull the points into groups", "/arrange by project"), ("/period", "Set the period for every view", "/period last 30 days"),
         ("/correct", "Fix an entry's text, date or speaker", "/correct date of this to 2 Oct"), ("/merge", "Show two groups as one", "/merge inv-sync into roblox-inventory"),
         ("/leave-out", "Keep something out of Cortex", "/leave-out the Downloads project"), ("/refresh", "Redo summaries for a stretch", "/refresh this week")]
ASK_EMPTY = f"""
<div class="console" style="left:30px;bottom:16px">
  <div class="co-h">{svg("glyph", 16)}<h3>Ask</h3><span class="eng2">Claude Code · sonnet · answers only from your record</span>
    <button class="gib" title="Change history">{svg("history", 15)}</button><button class="gib" title="Keep open">{svg("pin", 15)}</button><button class="gib" title="Collapse">{svg("chev", 15)}</button></div>
  <div class="co-b">
    <p class="purpose">Ask about your record or change how it is shown. Every change can be undone.</p>
    <div class="slist">{"".join(f'<div class="sr"><span class="sc">{c}</span><span class="sd">{d}</span><span class="se">{e}</span></div>' for c, d, e in SLASH)}</div>
    <div class="try"><span class="tl">Try</span>
      <button class="tq">What did I decide in “Cortex palette originality check”?</button>
      <button class="tq">Which Roblox questions are still open from last week?</button>
      <button class="tq">When did I last work on the profile store?</button></div>
  </div>
  <div class="co-in"><div class="seg2"><b>{svg("search", 14)}Find</b><b class="on">{svg("glyph", 14)}Ask</b></div>
    <span class="tx dim">Ask a question, or type / for an action<span class="caret"></span></span><span class="kbd">Enter</span></div>
</div>"""

# ---------------------------------------------------------------- Display popover and Layers menu
def slider(label, val, pct):
    return (f'<div class="prow"><span>{label}</span><span class="v">{val}</span></div>'
            f'<div class="sl"><span class="tr"></span><span class="fi" style="width:{pct}%"></span><span class="th" style="left:{pct}%"></span></div>')
DISPLAY = f"""
<div class="pop glass" style="left:12px;top:14px">
  <div class="pop-h"><h3>Display</h3><button class="gib" title="Reset display">{svg("undo", 15)}</button><button class="gib" title="Close (Esc)">{svg("x", 15)}</button></div>
  <div class="pb">
    <div class="plab">Points</div>
    {slider("Dot size", "100%", 25)}{slider("Glow", "100%", 50)}{slider("Brightness", "100%", 43)}{slider("Scatter", "100%", 50)}
    <div class="plab">Motion</div>
    <div class="gseg"><b class="on">Spin</b><b>Drift</b><b>Off</b></div>
    <div class="prow"><span>Speed</span><div class="gseg" style="width:150px"><b>×0.5</b><b class="on">×1</b><b>×2</b></div></div>
    <div class="prow"><span>Pause while pointing</span><span class="tg on"></span></div>
    <div class="prow"><span>Keep upright</span><span class="tg"></span></div>
    <div class="hintl">On by itself in charts. Spin sways while it is on.</div>
  </div>
  <div class="pfoot">{svg("glyph", 13)}Only this view changes. Other Cortex tabs keep theirs.</div>
</div>
<div class="menu" style="left:12px;top:478px">
  <div class="mh">Layers</div>
  <div class="mi on">{svg("check", 13)}Notes</div>
  <div class="mi on">{svg("check", 13)}Vault notes</div>
  <div class="mi"><span class="sp0"></span>Reference material<span class="mc2">5,454 hidden</span></div>
  <div class="mi on">{svg("check", 13)}Maps</div>
  <div class="mi on">{svg("check", 13)}Record</div>
  <div class="mi on">{svg("check", 13)}Undated cloud</div>
  <div class="mi"><span class="sp0"></span>Ask history</div>
  <div class="mi"><span class="sp0"></span>Subagent traffic</div>
  <div class="msep"></div>
  <div class="mi on">{svg("check", 13)}Anatomy haze</div>
</div>"""

# ---------------------------------------------------------------- empty stage with the first-run checklist
EMPTY = f"""
<div class="ecard glass">
  <h3>Your record is empty</h3>
  <p>Start with this vault's notes and your Claude Code sessions. Cortex copies words, never changes them, and asks before anything is sent to a model.</p>
  <ol class="chk">
    <li class="done"><span class="cb">{svg("check", 12)}</span>Add a source</li>
    <li><span class="cb"></span>Open one conversation frond<small>Double-click a branch off the spine</small></li>
    <li><span class="cb"></span>Ask one question<small>Press Tab in the command line</small></li>
  </ol>
  <div class="eacts"><button class="btn pri">{svg("plus", 13)}Add sources</button><button class="btn">Explore the sample record</button></div>
</div>
"""

# ---------------------------------------------------------------- Add sources, first-run step
FIRST = f"""
<div class="modal" role="dialog" aria-labelledby="fr-t" style="left:16px;top:18px">
  <div class="mo-h"><div style="flex:1"><h2 id="fr-t">Set up your record</h2><p>Choose what Cortex reads. Nothing is imported or sent until you press a button below.</p></div>
    <button class="ib" title="Close (Esc)">{svg("x", 16)}</button></div>
  <div class="srcs">
    <div class="src"><span class="si">{svg("book", 17)}</span><div class="tx"><div class="t1">This vault's notes</div><div class="t2"><span class="s">1,767 notes</span> · 5,454 reference notes stay hidden and are not sent</div></div><span class="tg on"></span></div>
    <div class="src"><span class="si">{svg("file", 17)}</span><div class="tx"><div class="t1">Documents in .raw/</div><div class="t2"><span class="s">2,233 files</span> · read in place; the Roblox creator docs count as reference</div></div><span class="tg on"></span></div>
    <div class="src"><span class="si">{svg("chip", 17)}</span><div class="tx"><div class="t1">Claude Code</div><div class="t2"><span class="s">381 sessions</span> · C:\\Users\\you\\.claude\\projects · text only, no tool output</div></div><span class="tg on"></span></div>
    <div class="src"><span class="si">{svg("msg", 17)}</span><div class="tx"><div class="t1">Chat exports</div><div class="t2">Claude.ai, ChatGPT and Gemini can be added later from Add sources</div></div><button class="btn">Choose…</button></div>
  </div>
  <div class="cons">
    <div class="cr">{svg("folder", 15)}<div><b>Where the text goes</b><span>Into .raw/chats/ in this vault, which OneDrive syncs. Detected secrets stay on this computer.</span></div></div>
    <div class="cr">{svg("glyph", 15)}<div><b>What models read</b><span>Claude Code and vault text go to Claude through your Claude Code login. Assistant replies from ChatGPT and Gemini are never sent.</span></div></div>
    <div class="cr">{svg("clock", 15)}<div><b>How long it takes</b><span>About 1,330 conversations and 1,767 notes to organise: roughly 5.2 million tokens, about 6 days at your daily cap of 1,000,000.</span></div></div>
  </div>
  <div class="choice">
    <label class="rad on"><span class="rd"></span><div><b>Import and organise</b><span>Import now; agents label and summarise within the daily cap.</span></div></label>
    <label class="rad"><span class="rd"></span><div><b>Import only</b><span>Import now; turn agents on later in Settings › Agents.</span></div></label>
  </div>
  <div class="mo-f"><p>{svg("shield", 14)}<span>Change any of this later in Settings › Privacy and Settings › Agents.</span></p><button class="btn">Not now</button><button class="btn pri">Start</button></div>
</div>"""

HTML = f"""<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width={PW}">
<title>Cortex panels</title>
<style>
{TOK}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; }}
body {{ width: {PW}px; height: {PH}px; background: #101114; overflow: hidden; }}
button {{ font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }}
h1, h2, h3, h4, h5, p, ol, dl, dd {{ margin: 0; }}
ol {{ padding: 0; list-style: none; }}
.cx-root {{ --stage-img: url(data:image/jpeg;base64,{STAGE_B64}); position: relative; width: {PW}px; height: {PH}px; font-family: var(--cx-font);
  font-size: var(--cx-fs-md); color: var(--cx-text-1); -webkit-font-smoothing: antialiased; }}
.ic {{ flex: none; display: block; }}
.mono {{ font-family: var(--cx-font-mono); font-variant-numeric: tabular-nums; }}
.dim {{ color: var(--cx-text-3); }}
.cap {{ position: absolute; font-size: 12px; color: #8b919b; letter-spacing: .01em; }}
.cap b {{ color: #c9ced6; font-weight: 600; margin-right: 6px; }}
.frame {{ position: absolute; overflow: hidden; border-radius: 6px; box-shadow: 0 0 0 1px rgba(255,255,255,.06); }}
.sheet {{ width: 400px; height: 889px; background: var(--cx-chrome); border-left: 1px solid var(--cx-line); display: flex; flex-direction: column; position: relative; }}
.sheet::after {{ content: ''; position: absolute; left: 1px; right: 0; bottom: 0; height: 48px; background: linear-gradient(180deg, rgba(28,28,28,0), var(--cx-chrome)); pointer-events: none; }}
.sh-head {{ height: 52px; flex: none; display: flex; align-items: center; gap: 4px; padding: 0 8px 0 10px; border-bottom: 1px solid var(--cx-line); }}
.sh-t {{ flex: 1; min-width: 0; padding-left: 4px; }}
.sh-t h2 {{ font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
.crumb {{ font-size: 11px; color: var(--cx-text-3); margin-bottom: 1px; }}
.sh-a {{ display: flex; gap: 2px; }}
.ib {{ width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--cx-r-sm); color: var(--cx-text-2); }}
.sh-body {{ flex: 1; overflow: hidden; padding: 14px 20px 20px; }}
.sub {{ font-size: 13px; line-height: 1.5; color: var(--cx-text-2); }}
.sec {{ margin-top: 18px; }}
.sec-h {{ display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }}
.sec-h h3 {{ font-size: 12px; font-weight: 600; color: var(--cx-text-2); }}
.sec-h .r {{ margin-left: auto; font: 11px var(--cx-font-mono); color: var(--cx-text-3); display: inline-flex; align-items: center; gap: 6px; }}
.sec-h .r.rt {{ font-family: var(--cx-font); font-size: 11.5px; }}
.lk {{ margin-left: auto; font-size: 12px; color: var(--cx-text-2); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(255,255,255,.25); }}
.ax {{ font: 10px var(--cx-font-mono); fill: var(--cx-text-3); }}
.ax.hi {{ fill: #eceef2; }}
.lane {{ font: 10.5px var(--cx-font); fill: var(--cx-text-3); }}
.lane.you {{ fill: {YOU}; font-weight: 600; }} .lane.ast {{ fill: {AST}; }}
.kgl {{ font: 10px "Segoe UI Symbol", var(--cx-font); }}
.lg {{ display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 11.5px; color: var(--cx-text-2); align-items: center; }}
.lg .g {{ font: 12px "Segoe UI Symbol"; margin-right: 4px; }}
.segc {{ display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px; background: var(--cx-chrome-alt); border: 1px solid var(--cx-line); }}
.segc b {{ flex: 1; justify-content: center; white-space: nowrap; height: 24px; padding: 0 9px; display: flex; align-items: center; gap: 6px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--cx-text-3); }}
.segc b.on {{ background: var(--cx-chrome-raised); color: var(--cx-text-1); box-shadow: 0 1px 2px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.06); }}
.segc.sm {{ margin-right: 4px; }} .segc.sm b {{ height: 22px; padding: 0 8px; }}
.bdg {{ min-width: 18px; height: 16px; padding: 0 5px; border-radius: 8px; background: var(--cx-accent-soft); color: var(--cx-text-1); font: 500 10.5px/16px var(--cx-font-mono); }}
.tg {{ width: 30px; height: 18px; border-radius: 9px; background: rgba(255,255,255,.14); position: relative; flex: none; display: inline-block; }}
.tg::after {{ content: ""; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: #c3c8d1; }}
.tg.on {{ background: var(--cx-accent); }} .tg.on::after {{ left: 14px; background: #fff; }}
.tg.mini {{ width: 24px; height: 14px; }} .tg.mini::after {{ width: 10px; height: 10px; }} .tg.mini.on::after {{ left: 12px; }}
.sp {{ display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }}
.sp.you {{ background: {YOU}; }} .sp.ast {{ border: 1.5px solid {AST}; }}
.sq {{ display: inline-block; width: 6px; height: 6px; background: var(--cx-tool); }}
.kg {{ width: 18px; height: 18px; flex: none; border-radius: 4px; display: grid; place-items: center; font: 12px "Segoe UI Symbol", var(--cx-font); border: 1px dashed rgba(184,166,255,.45); }}
.k1 {{ color: {GLOW[0]}; }} .k2 {{ color: {GLOW[1]}; }} .k5 {{ color: {GLOW[4]}; }} .km {{ color: #fff; border-style: solid; border-color: rgba(255,255,255,.3); }}
.mc {{ display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border-radius: 10px; border: 1px dashed rgba(184,166,255,.55); font: 11px var(--cx-font-mono); color: var(--cx-machine); }}
.mc .ic {{ color: var(--cx-machine); }}
.btn {{ height: 28px; padding: 0 11px; display: inline-flex; align-items: center; gap: 6px; border-radius: var(--cx-r-sm); border: 1px solid var(--cx-line-strong); font-size: 12.5px; color: var(--cx-text-1); background: var(--cx-chrome); }}
.btn.pri {{ background: var(--cx-accent-fill); border-color: transparent; color: var(--cx-on-accent); font-weight: 600; }}

/* entry reader */
.factsg {{ display: grid; grid-template-columns: 62px 1fr 48px 1fr; gap: 5px 8px; font-size: 12px; padding: 10px 12px; border: 1px solid var(--cx-line); border-radius: 8px; background: var(--cx-chrome-alt); }}
.factsg dt {{ color: var(--cx-text-3); }}
.factsg dd {{ color: var(--cx-text-1); display: flex; align-items: center; gap: 6px; white-space: nowrap; }}
.factsg dd .ic {{ color: var(--cx-text-3); }}
.factsg dd.w {{ grid-column: span 3; }}
.factsg .ad, .t2 .ad {{ width: 7px; height: 7px; border-radius: 50%; display: inline-block; }}
.conf {{ height: 18px; padding: 0 7px; border-radius: 9px; background: rgba(76,195,138,.14); color: #8fe0b6; font-size: 11px; display: inline-flex; align-items: center; }}
.factsg u {{ text-decoration: none; border-bottom: 1px dotted var(--cx-text-3); color: var(--cx-text-2); font-size: 11.5px; }}
.rd-title {{ margin-top: 12px; font-size: var(--cx-fs-title); font-weight: 600; line-height: 1.3; letter-spacing: -.01em; }}
.verb {{ margin-top: 10px; padding: 2px 0 2px 14px; border-left: 2px solid {YOU}; font-size: var(--cx-fs-body); line-height: var(--cx-lh-read); }}
.verb p + p {{ margin-top: 10px; }}
.scrub {{ margin-top: 14px; }}
.sc-h {{ display: flex; justify-content: space-between; font-size: 11.5px; color: var(--cx-text-3); margin-bottom: 4px; }}
.sc-k {{ display: flex; gap: 12px; font-size: 11px; color: var(--cx-text-3); align-items: center; margin-top: 2px; }}
.sc-k span {{ display: inline-flex; align-items: center; gap: 5px; }}
.sc-k .r {{ margin-left: auto; color: var(--cx-text-2); }}
.mchip {{ height: 22px; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border-radius: var(--cx-r-xs); border: 1px dashed rgba(184,166,255,.55); font-size: 11.5px; color: var(--cx-text-2); }}
.mchip b {{ color: var(--cx-text-3); font-weight: 400; }}
.uchip {{ height: 22px; display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: var(--cx-r-xs); border: 1px solid var(--cx-line-strong); font-size: 11.5px; color: var(--cx-text-2); }}
.chips {{ display: flex; flex-wrap: wrap; gap: 5px; }}
.mnote {{ margin-top: 7px; font: 11.5px var(--cx-font); color: var(--cx-text-3); display: flex; align-items: center; gap: 6px; }}
.mnote .ic {{ color: var(--cx-machine); }}
.rows {{ border-top: 1px solid var(--cx-line); }}
.row {{ display: flex; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--cx-line); }}
.row .mk {{ width: 18px; flex: none; display: grid; place-items: center; }}
.row .tx {{ flex: 1; min-width: 0; }}
.t1 {{ font-size: 12.5px; color: var(--cx-text-1); line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
.t2 {{ font-size: 11px; color: var(--cx-text-3); margin-top: 2px; display: flex; align-items: center; gap: 6px; }}
.t2 .ic {{ color: var(--cx-text-3); }}
.terms {{ display: flex; gap: 5px; margin-bottom: 6px; }}
.term {{ height: 22px; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border-radius: 11px; border: 1px solid var(--cx-line); font-size: 11.5px; color: var(--cx-text-2); }}
.term b {{ font: 400 10.5px var(--cx-font-mono); color: var(--cx-text-3); }}
.term.on {{ background: var(--cx-chrome-active); color: var(--cx-text-1); border-color: var(--cx-line-strong); }}
.hist li {{ display: flex; align-items: baseline; gap: 9px; font-size: 12px; color: var(--cx-text-2); padding: 3px 0; position: relative; }}
.hist li b {{ margin-left: auto; font: 400 10.5px var(--cx-font-mono); color: var(--cx-text-3); white-space: nowrap; }}
.hist .hd {{ width: 7px; height: 7px; border-radius: 50%; background: var(--cx-text-3); flex: none; transform: translateY(-1px); }}
.hist .hd.m {{ background: none; border: 1.5px dotted var(--cx-machine); }} .hist .hd.y {{ background: {YOU}; }}
.hist u {{ color: var(--cx-text-2); text-underline-offset: 3px; }}

/* map reader */
.mapk {{ display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--cx-text-2); white-space: nowrap; }}
.brief .mc {{ align-self: flex-start; }}
.brief {{ margin-top: 12px; padding: 2px 0 2px 12px; border-left: 2px dotted var(--cx-machine); display: flex; flex-direction: column; gap: 7px; }}
.bl {{ display: flex; gap: 10px; align-items: flex-start; font-size: 12.5px; line-height: 1.4; }}
.em {{ display: flex; flex-direction: column; gap: 2px; padding-top: 4px; flex: none; }}
.em .b {{ width: 24px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.07); overflow: hidden; display: block; }}
.em .b i {{ display: block; height: 100%; border-radius: 2px; }}
.kinds {{ margin-top: 14px; display: flex; flex-wrap: wrap; gap: 4px; }}
.kinds b {{ height: 22px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 11px; border: 1px solid var(--cx-line); font-size: 11.5px; font-weight: 500; color: var(--cx-text-2); }}
.kinds b.on {{ background: var(--cx-chrome-active); color: var(--cx-text-1); border-color: var(--cx-line-strong); }}
.grp {{ margin-top: 12px; }}
.gh {{ display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--cx-text-2); margin-bottom: 4px; }}
.gh b {{ font: 400 11px var(--cx-font-mono); color: var(--cx-text-3); }}
.nr {{ display: flex; align-items: center; gap: 8px; min-height: 27px; padding: 0 6px 0 26px; border-radius: 6px; color: var(--cx-text-3); }}
.nr.open {{ background: rgba(255,255,255,.04); }}
.nt {{ flex: 1; font-size: 12.5px; color: var(--cx-text-1); }}
.nd {{ font-size: 10.5px; color: var(--cx-text-3); }}
.q {{ display: flex; align-items: baseline; gap: 8px; padding: 4px 6px 4px 40px; font-size: 12px; line-height: 1.45; color: var(--cx-text-2); }}
.q .sp {{ transform: translateY(1px); }}
.q .qt {{ flex: 1; }}
.q .qw {{ font: 10.5px var(--cx-font-mono); color: var(--cx-text-3); }}
.more {{ padding: 3px 0 0 26px; font-size: 11.5px; color: var(--cx-text-3); }}
.mfoot {{ margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--cx-line); display: flex; font-size: 11.5px; color: var(--cx-text-3); }}

/* time */
.rhythm {{ margin-top: 12px; }}
.rhythm svg {{ display: block; }}
/* agents */
.card {{ border: 1px solid var(--cx-line); border-radius: var(--cx-r-md); background: var(--cx-chrome-alt); padding: 11px 12px 11px 14px; }}
.ag-st {{ display: flex; align-items: center; gap: 10px; }}
.ag-st .spin {{ width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: var(--cx-accent-soft); color: var(--cx-accent); }}
.ag-st h4 {{ font-size: 14px; font-weight: 600; }}
.ag-st p {{ font-size: 12px; color: var(--cx-text-3); margin-top: 1px; }}
.ag-btns {{ margin-left: auto; }}
.eng {{ margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--cx-line); font-size: 12px; color: var(--cx-text-3); line-height: 1.5; }}
.eng b {{ color: var(--cx-text-2); font-weight: 500; }}
.big {{ display: flex; align-items: baseline; gap: 8px; }}
.big .n {{ font: 600 24px var(--cx-font-mono); letter-spacing: -.02em; }}
.big .u {{ font-size: 12.5px; color: var(--cx-text-3); }}
.meter {{ height: 6px; border-radius: 3px; background: rgba(255,255,255,.07); overflow: hidden; margin-top: 7px; }}
.meter i {{ display: block; height: 100%; border-radius: 3px; }}
.mt {{ display: flex; justify-content: space-between; margin-top: 6px; font-size: 11.5px; color: var(--cx-text-3); }}
.wq {{ display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--cx-text-2); margin-bottom: 8px; }}
.wq b {{ color: var(--cx-text-1); font-weight: 600; }}
.sb {{ display: flex; align-items: center; gap: 8px; height: 18px; font-size: 11.5px; color: var(--cx-text-2); }}
.sbn {{ width: 76px; }} .sbt {{ width: 40px; text-align: right; font-size: 10.5px; color: var(--cx-text-3); }}
.sbb {{ flex: 1; height: 6px; border-radius: 3px; overflow: hidden; display: flex; background: rgba(255,255,255,.05); }}
.sbb i {{ display: block; height: 100%; }}
.sbk {{ display: flex; gap: 12px; margin-top: 4px; font-size: 10.5px; color: var(--cx-text-3); }}
.sbk span {{ display: inline-flex; align-items: center; gap: 5px; }} .sbk i {{ width: 8px; height: 6px; border-radius: 2px; display: inline-block; }}
.tbl {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
.tbl th {{ text-align: left; font-weight: 500; color: var(--cx-text-3); font-size: 11px; padding: 0 0 5px; border-bottom: 1px solid var(--cx-line); }}
.tbl td {{ padding: 5px 0; border-bottom: 1px solid var(--cx-line); color: var(--cx-text-2); vertical-align: middle; }}
.tbl td .ic {{ display: inline-block; vertical-align: -1px; margin-right: 4px; color: var(--cx-text-3); }}
.tbl td.n {{ font-family: var(--cx-font-mono); text-align: right; color: var(--cx-text-1); }}
.tbl th.n {{ text-align: right; }}
.tbl tr.sub td {{ color: var(--cx-text-3); font-size: 11.5px; padding-left: 16px; }}
.tbl tr.sub td.n {{ color: var(--cx-text-2); padding-left: 0; }}
.tbl tr.det td {{ border-bottom: 1px solid var(--cx-line); padding: 2px 0 7px; }}
.rf {{ display: flex; gap: 6px; }}
.rf span {{ flex: 1; display: flex; flex-direction: column; gap: 1px; padding: 4px 7px; border-radius: 6px; background: rgba(255,255,255,.04); font-size: 10.5px; color: var(--cx-text-3); }}
.rf b {{ font: 600 12px var(--cx-font-mono); color: var(--cx-text-1); }}
.stc {{ display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; }}
.stc i {{ width: 7px; height: 7px; border-radius: 50%; }}
/* read */
.nbtn {{ height: 26px; padding: 0 9px; margin-right: 4px; display: inline-flex; align-items: center; gap: 6px; border-radius: 6px; border: 1px solid var(--cx-line-strong); font-size: 12px; color: var(--cx-text-1); }}
.nbtn .ic {{ color: var(--cx-text-3); }}
.field {{ height: 30px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 10px; border-radius: 7px; border: 1px solid var(--cx-line); background: var(--cx-chrome-alt); font-size: 12.5px; color: var(--cx-text-3); }}
.field .tr {{ margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--cx-text-3); }}
.rdr {{ margin-top: 10px; display: flex; gap: 6px; align-items: center; }}
.tgb {{ width: 28px; height: 28px; display: grid; place-items: center; border-radius: 7px; border: 1px solid var(--cx-line); color: var(--cx-text-3); }}
.tgb.on {{ background: var(--cx-chrome-active); color: var(--cx-text-1); border-color: var(--cx-line-strong); }}
.preset {{ margin-top: 10px; display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--cx-text-3); }}
.preset b {{ color: var(--cx-text-1); font-size: 13px; }}
.dayh {{ margin: 12px 0 2px; font-size: 11px; font-weight: 600; color: var(--cx-text-3); }}
.lrow {{ display: flex; align-items: center; gap: 10px; height: 44px; border-bottom: 1px solid var(--cx-line); }}
.split {{ width: 4px; height: 32px; border-radius: 2px; overflow: hidden; display: flex; flex-direction: column; flex: none; }}
.split i {{ display: block; width: 100%; }}
.lrow .tx {{ flex: 1; min-width: 0; }}
.when {{ font: 11px var(--cx-font-mono); color: var(--cx-text-3); white-space: nowrap; align-self: flex-start; margin-top: 7px; }}
.t2.snip span {{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--cx-text-3); }}

/* stage frames, popover, menu, console */
.stagebg {{ background: var(--cx-stage) var(--stage-img) no-repeat; }}
.glass {{ background: var(--cx-glass); border: 1px solid var(--cx-glass-line); border-radius: var(--cx-r-md); box-shadow: var(--cx-shadow-glass);
  backdrop-filter: blur(var(--cx-glass-blur)) saturate(1.15); -webkit-backdrop-filter: blur(var(--cx-glass-blur)) saturate(1.15); }}
.pop {{ position: absolute; width: var(--cx-pop-w); color: var(--cx-stage-text-1); background: var(--cx-glass-strong); box-shadow: var(--cx-shadow-pop); }}
.pop-h {{ display: flex; align-items: center; gap: 6px; padding: 10px 8px 4px 14px; }}
.pop-h h3 {{ font-size: 13px; font-weight: 600; flex: 1; }}
.gib {{ width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; color: var(--cx-stage-text-2); }}
.pb {{ padding: 2px 14px 12px; }}
.prow {{ display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 30px; font-size: 12.5px; color: var(--cx-stage-text-2); }}
.prow .v {{ color: var(--cx-stage-text-3); font: 11.5px var(--cx-font-mono); }}
.plab {{ font-size: 11.5px; font-weight: 600; color: var(--cx-stage-text-3); margin: 10px 0 2px; }}
.gseg {{ display: flex; padding: 2px; gap: 2px; border-radius: 8px; background: rgba(255,255,255,.05); }}
.gseg b {{ flex: 1; height: 26px; padding: 0 8px; display: flex; align-items: center; justify-content: center; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--cx-stage-text-3); }}
.gseg b.on {{ background: var(--cx-glass-active); color: var(--cx-stage-text-1); box-shadow: inset 0 0 0 1px rgba(255,255,255,.07); }}
.sl {{ position: relative; height: 12px; margin: -2px 0 2px; }}
.sl .tr {{ position: absolute; left: 0; right: 0; top: 5px; height: 2px; border-radius: 1px; background: rgba(255,255,255,.14); }}
.sl .fi {{ position: absolute; left: 0; top: 5px; height: 2px; border-radius: 1px; background: var(--cx-accent); }}
.sl .th {{ position: absolute; top: -1px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: #eceef2; box-shadow: 0 1px 4px rgba(0,0,0,.6); }}
.hintl {{ font-size: 11px; color: var(--cx-stage-text-3); margin-top: -4px; }}
.pfoot {{ border-top: 1px solid var(--cx-glass-line); padding: 9px 14px; font-size: 11.5px; color: var(--cx-stage-text-3); display: flex; gap: 8px; align-items: center; }}
.menu {{ position: absolute; width: 262px; white-space: nowrap; padding: 5px; border-radius: 8px; background: #26282e; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 12px 32px rgba(0,0,0,.55); color: #dadada; font-size: 13px; }}
.menu .mh {{ padding: 5px 10px 4px; font-size: 11.5px; color: #9aa0aa; }}
.menu .mi {{ height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-radius: 5px; }}
.menu .mi .ic {{ color: #dadada; }}
.menu .mi:nth-child(3) {{ background: rgba(255,255,255,.07); }}
.menu .sp0 {{ width: 13px; flex: none; }}
.menu .mc2 {{ margin-left: auto; font: 11px var(--cx-font-mono); color: #9aa0aa; }}
.menu .msep {{ height: 1px; background: rgba(255,255,255,.1); margin: 4px 6px; }}
.console {{ position: absolute; width: 640px; border-radius: var(--cx-r-lg); background: var(--cx-glass-strong); border: 1px solid var(--cx-glass-line-strong); box-shadow: var(--cx-shadow-pop); color: var(--cx-stage-text-1);
  backdrop-filter: blur(var(--cx-glass-blur)); overflow: hidden; }}
.co-h {{ height: 42px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--cx-glass-line); }}
.co-h h3 {{ font-size: 13px; font-weight: 600; }}
.co-h .eng2 {{ font-size: 11.5px; color: var(--cx-stage-text-3); flex: 1; }}
.co-b {{ padding: 12px 16px 4px; display: flex; flex-direction: column; gap: 10px; }}
.msg-you {{ align-self: flex-end; max-width: 82%; padding: 8px 12px; border-radius: 12px 12px 4px 12px; background: rgba(222,177,37,.10); border: 1px solid rgba(222,177,37,.24); font-size: 13px; line-height: 1.45; }}
.slash {{ font-family: var(--cx-font-mono); color: #f2d27a; }}
.msg-cx {{ display: flex; gap: 10px; font-size: 13px; line-height: 1.55; }}
.msg-cx .av {{ width: 22px; height: 22px; flex: none; border-radius: 6px; display: grid; place-items: center; background: rgba(184,166,255,.14); color: var(--cx-machine); margin-top: 1px; }}
.cite {{ display: inline-flex; align-items: center; height: 17px; padding: 0 5px; margin: 0 1px; border-radius: 4px; font: 10.5px var(--cx-font-mono); background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1); vertical-align: 1px; }}
.rcpt {{ margin-left: 32px; display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 10px; border-radius: 9px; border: 1px solid var(--cx-glass-line); background: rgba(255,255,255,.03); font-size: 12.5px; }}
.rcpt .ok {{ width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: rgba(76,195,138,.16); color: var(--cx-ok); flex: none; }}
.rcpt .w {{ flex: 1; }}
.rcpt .w small {{ color: var(--cx-stage-text-3); margin-left: 6px; font-family: var(--cx-font-mono); font-size: 11px; }}
.rcpt .u {{ display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--cx-stage-text-2); padding: 0 6px; height: 24px; }}
.prop {{ margin-left: 32px; border-radius: 10px; border: 1px solid rgba(138,92,245,.55); background: rgba(138,92,245,.08); padding: 10px 10px 10px 12px; }}
.prop h5 {{ font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 7px; }}
.prop p {{ margin-top: 4px; font-size: 12px; color: var(--cx-stage-text-2); line-height: 1.45; }}
.prop p b {{ color: var(--cx-stage-text-1); font-weight: 600; }}
.prop .why {{ display: flex; align-items: center; gap: 6px; padding-left: 8px; border-left: 2px dotted var(--cx-machine); color: var(--cx-stage-text-3); }}
.prop .why .ic {{ color: var(--cx-machine); }}
.prop .acts {{ margin-top: 9px; display: flex; gap: 6px; align-items: center; }}
.prop .acts small {{ margin-left: auto; font-size: 11px; color: var(--cx-stage-text-3); }}
.gbtn {{ height: 28px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px; border-radius: 7px; font-size: 12.5px; color: var(--cx-stage-text-1); border: 1px solid var(--cx-glass-line-strong); }}
.gbtn.pri {{ background: var(--cx-accent-fill); border-color: transparent; color: #fff; font-weight: 600; }}
.co-in {{ margin: 10px 8px 8px; height: 44px; border-radius: 12px; display: flex; align-items: center; gap: 10px; padding: 0 8px 0 7px; background: rgba(255,255,255,.04); border: 1px solid var(--cx-glass-line-strong); }}
.seg2 {{ height: 30px; padding: 2px; border-radius: 9px; background: rgba(255,255,255,.05); display: flex; gap: 2px; }}
.seg2 b {{ height: 26px; padding: 0 10px 0 8px; display: flex; align-items: center; gap: 6px; border-radius: 7px; font-size: 12px; font-weight: 500; color: var(--cx-stage-text-3); }}
.seg2 b.on {{ background: var(--cx-glass-active); color: var(--cx-stage-text-1); }}
.co-in .tx {{ flex: 1; font-size: 13px; color: var(--cx-stage-text-3); }}
.caret {{ display: inline-block; width: 1.5px; height: 15px; background: var(--cx-accent); vertical-align: -3px; margin-left: 2px; }}
.kbd {{ font: 11px var(--cx-font-mono); color: var(--cx-stage-text-3); border: 1px solid var(--cx-glass-line-strong); border-radius: 4px; padding: 1px 5px; }}
.purpose {{ font-size: 13px; color: var(--cx-stage-text-2); }}
.slist {{ display: flex; flex-direction: column; border-top: 1px solid var(--cx-glass-line); }}
.sr {{ display: grid; grid-template-columns: 92px 1fr auto; align-items: center; gap: 10px; height: 31px; border-bottom: 1px solid var(--cx-glass-line); font-size: 12.5px; }}
.sc {{ font-family: var(--cx-font-mono); color: #f2d27a; }}
.sd {{ color: var(--cx-stage-text-1); }}
.se {{ font: 11px var(--cx-font-mono); color: var(--cx-stage-text-3); }}
.try {{ display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-bottom: 6px; }}
.try .tl {{ font-size: 11.5px; font-weight: 600; color: var(--cx-stage-text-3); margin-right: 2px; }}
.tq {{ height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--cx-glass-line-strong); font-size: 12px; color: var(--cx-stage-text-1); background: rgba(255,255,255,.03); }}
/* empty state, hint */
.ecard {{ position: absolute; left: 170px; top: 236px; width: 360px; padding: 18px 18px 16px; background: var(--cx-glass-strong); }}
.ecard h3 {{ font-size: 15px; font-weight: 600; color: var(--cx-stage-text-1); }}
.ecard p {{ margin-top: 6px; font-size: 12.5px; line-height: 1.5; color: var(--cx-stage-text-2); }}
.chk {{ margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }}
.chk li {{ display: flex; align-items: flex-start; gap: 9px; font-size: 13px; color: var(--cx-stage-text-1); flex-wrap: wrap; }}
.chk li small {{ flex-basis: 100%; padding-left: 27px; margin-top: -4px; font-size: 11.5px; color: var(--cx-stage-text-3); }}
.chk .cb {{ width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--cx-glass-line-strong); display: grid; place-items: center; flex: none; }}
.chk li.done {{ color: var(--cx-stage-text-3); text-decoration: line-through; text-decoration-color: rgba(255,255,255,.3); }}
.chk li.done .cb {{ background: var(--cx-ok); border-color: transparent; color: #0c1a12; }}
.eacts {{ margin-top: 14px; display: flex; gap: 6px; }}
.hint {{ position: absolute; width: 250px; padding: 10px 12px; border-radius: 10px; background: #2b2f3a; border: 1px solid rgba(255,255,255,.16); box-shadow: 0 10px 28px rgba(0,0,0,.5); color: var(--cx-stage-text-1); font-size: 12.5px; line-height: 1.45; }}
.hint::after {{ content: ""; position: absolute; left: 34px; bottom: -7px; width: 12px; height: 12px; background: #2b2f3a; border-right: 1px solid rgba(255,255,255,.16); border-bottom: 1px solid rgba(255,255,255,.16); transform: rotate(45deg); }}
.hint button {{ margin-top: 6px; font-size: 12px; color: #cbb8ff; }}
.estrip {{ position: absolute; left: 0; right: 0; bottom: 0; height: 64px; background: var(--cx-strip); border-top: 1px solid var(--cx-glass-line); }}
.estrip span {{ position: absolute; left: 50%; top: 24px; transform: translateX(-50%); font-size: 12px; color: var(--cx-stage-text-3); }}
/* modal */
.modal {{ position: absolute; width: 720px; border-radius: 12px; background: var(--cx-chrome); border: 1px solid var(--cx-line); box-shadow: 0 24px 64px rgba(0,0,0,.6); }}
.mo-h {{ display: flex; align-items: flex-start; gap: 10px; padding: 18px 16px 12px 22px; }}
.mo-h h2 {{ font-size: 18px; font-weight: 600; letter-spacing: -.01em; }}
.mo-h p {{ margin-top: 4px; font-size: 13px; color: var(--cx-text-2); line-height: 1.45; }}
.srcs {{ margin: 0 22px; border: 1px solid var(--cx-line); border-radius: 10px; overflow: hidden; }}
.src {{ display: flex; align-items: center; gap: 12px; padding: 9px 12px 9px 14px; border-bottom: 1px solid var(--cx-line); }}
.src:last-child {{ border-bottom: 0; }}
.src .si {{ width: 32px; height: 32px; flex: none; border-radius: 8px; display: grid; place-items: center; background: var(--cx-chrome-alt); border: 1px solid var(--cx-line); color: var(--cx-text-2); }}
.src .tx {{ flex: 1; min-width: 0; }}
.src .t1 {{ font-size: 13px; font-weight: 600; }}
.src .t2 {{ font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }}
.src .t2 .s {{ color: var(--cx-text-2); }}
.cons {{ margin: 12px 22px 0; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; background: var(--cx-chrome-alt); border: 1px solid var(--cx-line); }}
.cr {{ display: flex; gap: 10px; align-items: flex-start; }}
.cr .ic {{ color: var(--cx-text-3); margin-top: 2px; }}
.cr div {{ display: flex; flex-direction: column; gap: 1px; }}
.cr b {{ font-size: 12.5px; font-weight: 600; }}
.cr span {{ font-size: 12px; color: var(--cx-text-2); line-height: 1.45; }}
.cr .mono {{ font-size: 11.5px; }}
.choice {{ margin: 12px 22px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }}
.rad {{ display: flex; gap: 10px; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--cx-line); }}
.rad.on {{ border-color: var(--cx-accent); box-shadow: inset 0 0 0 1px var(--cx-accent); background: rgba(138,92,245,.06); }}
.rad .rd {{ width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--cx-line-strong); flex: none; margin-top: 1px; }}
.rad.on .rd {{ border: 5px solid var(--cx-accent); }}
.rad div {{ display: flex; flex-direction: column; gap: 2px; }}
.rad b {{ font-size: 13px; }} .rad span {{ font-size: 11.5px; color: var(--cx-text-3); line-height: 1.4; }}
.mo-f {{ display: flex; align-items: center; gap: 8px; padding: 14px 16px 16px 22px; }}
.mo-f p {{ flex: 1; font-size: 12px; color: var(--cx-text-3); line-height: 1.45; display: flex; gap: 8px; }}
.mo-f .ic {{ color: var(--cx-ok); }}
</style></head>
<body><div class="cx-root theme-dark">

<div class="cap" style="left:30px;top:22px"><b>Reader</b>a message in your own words · sheet 400 × 889</div>
<div class="cap" style="left:454px;top:22px"><b>Reader</b>a project map · sheet</div>
<div class="cap" style="left:878px;top:22px"><b>Time</b>the spine laid flat · sheet</div>
<div class="cap" style="left:1302px;top:22px"><b>Agents</b>ledger tab · sheet</div>
<div class="cap" style="left:1726px;top:22px"><b>Read</b>by date, Today preset on · sheet</div>
<div class="frame" style="left:30px;top:46px;width:400px;height:889px">{ENTRY}</div>
<div class="frame" style="left:454px;top:46px;width:400px;height:889px">{MAP}</div>
<div class="frame" style="left:878px;top:46px;width:400px;height:889px">{TIME}</div>
<div class="frame" style="left:1302px;top:46px;width:400px;height:889px">{AGENTS}</div>
<div class="frame" style="left:1726px;top:46px;width:400px;height:889px">{READ}</div>

<div class="cap" style="left:30px;top:972px"><b>Ask</b>a thread: answers with citations, changes with Undo, a proposal waiting for Apply</div>
<div class="cap" style="left:754px;top:972px"><b>Ask</b>empty: the actions as slash commands, and questions drawn from your recent record</div>
<div class="cap" style="left:1478px;top:972px"><b>Display</b>popover (points and motion) · the key bar's Layers menu</div>
<div class="frame stagebg" style="left:30px;top:996px;width:700px;height:672px;background-position:-415px -30px">{ASK_THREAD}</div>
<div class="frame stagebg" style="left:754px;top:996px;width:700px;height:672px;background-position:-415px -30px">{ASK_EMPTY}</div>
<div class="frame stagebg" style="left:1478px;top:996px;width:330px;height:820px;background-position:-690px 0px">{DISPLAY}</div>

<div class="cap" style="left:30px;top:1840px"><b>First run</b>the empty stage: the haze silhouette and a checklist that ticks itself off</div>
<div class="cap" style="left:754px;top:1840px"><b>First run</b>Set up your record: what is read, where it goes, what it costs · Obsidian modal 720 wide</div>
<div class="frame" style="left:30px;top:1864px;width:700px;height:720px;background:var(--cx-stage) url(data:image/jpeg;base64,{HAZE_B64}) no-repeat">{EMPTY}<div class="estrip"><span>No dated entries yet.</span></div></div>
<div class="frame" style="left:754px;top:1864px;width:752px;height:720px;background:#0b0c0e">{FIRST}</div>

</div></body></html>
"""
open(OUT, "w", encoding="utf-8").write(HTML)
print("wrote", OUT, len(HTML))
