"""Cortex originality check for copy (docs/CORTEX-UX.md section 0.1).

Fails when user-facing text contains an expression the design review traced to the recordings or the
reference product's site: page and section names, sentence-length copy, control labels and vocabulary.
Each pattern names the review finding that retired it. Short generic words (Speed, Group by, Legend,
Timeline, Search) are allowed and are not listed.

Run: python originality_check.py [files...]
  With no arguments it checks the two mockups (../main.html, ../panels.html). Point it at src/ui/copy.ts, the
  markdown note templates (store/notesWriter.ts) and any other copy source; the build must run it on those
  (CORTEX-UX section 12). Exit status 1 if anything matches.
"""
import os, re, sys

I, C = re.IGNORECASE, 0   # I = any case (sentences); C = exact case (labels and names)
BANNED = [
    # ORIG-01  the authorship page
    ("ORIG-01", I, r"of (the record|everything here) is in your own words"), ("ORIG-01", I, r"in your own words, and what"),
    ("ORIG-01", I, r"\bfor you to do\b"), ("ORIG-01", I, r"\bdate seals?\b"), ("ORIG-01", I, r"signed blocks"),
    ("ORIG-01", I, r"public timestamp"), ("ORIG-01", I, r"readers of your record"), ("ORIG-01", I, r"no model has read"),
    ("ORIG-01", I, r"who has read"), ("ORIG-01", I, r"still waiting"), ("ORIG-01", I, r"proof of dates"), ("ORIG-01", I, r"in your record\b.*\byou\b"),
    # ORIG-02  the time page
    ("ORIG-02", I, r"when you wrote"), ("ORIG-02", I, r"aren't counted here"), ("ORIG-02", I, r"undated entries (are not|aren't) (shown|counted)"),
    ("ORIG-02", I, r"drag across any chart"), ("ORIG-02", I, r"labels over time"), ("ORIG-02", C, r"\bDropped\b"), ("ORIG-02", C, r"\bRejections?\b"),
    # ORIG-05  the conversation note
    ("ORIG-05", I, r"not your words"), ("ORIG-05", I, r"what happened"), ("ORIG-05", I, r"how (it|the conversation) is (labelled|tagged)"),
    ("ORIG-05", I, r"your calls and corrections"), ("ORIG-05", I, r"what you decided or corrected"), ("ORIG-05", C, r"\bParts \("), ("ORIG-05", C, r"\bSources \(\d|\bSources \(‹"),
    # ORIG-06  the hub reader
    ("ORIG-06", I, r"every point links to the passages"), ("ORIG-06", I, r"passages (it|they) rests? on"), ("ORIG-06", C, r"\bWithin:"),
    ("ORIG-06", C, r"\bCurrent state\b"), ("ORIG-06", C, r"\bNext steps\b"), ("ORIG-06", C, r"\bDecisions so far\b"), ("ORIG-06", C, r"\bKey decisions\b"),
    ("ORIG-06", C, r"\bWhat it covers\b"), ("ORIG-06", C, r"\bWhat it means here\b"), ("ORIG-06", C, r"\bWhere it shows up\b"),
    ("ORIG-06", I, r"from the assistant only"), ("ORIG-06", I, r"from an assistant's words"), ("ORIG-06", I, r"last touched \S+ days"),
    ("ORIG-06", I, r"\b(project|area|concept) hub\b"),
    # ORIG-07  the chart panel
    ("ORIG-07", I, r"each to its own peak"), ("ORIG-07", C, r"\bWhat shows\b"), ("ORIG-07", I, r"merge and fold"), ("ORIG-07", I, r"name this (chart|table)"),
    ("ORIG-07", I, r"export counts"), ("ORIG-07", I, r"export picture"), ("ORIG-07", I, r"show the largest"), ("ORIG-07", I, r"because \S+ is already (across|down)"),
    ("ORIG-07", C, r"\b(Across|Bands|Around|Rings|Lines|Waves):"), ("ORIG-07", I, r"moving average . exponential"), ("ORIG-07", I, r"you're busiest around"),
    ("ORIG-07", I, r"comes back most"), ("ORIG-07", I, r"of these are still (active|going)"), ("ORIG-07", I, r"the biggest stream runs"),
    ("ORIG-07", I, r"you started mostly on"), ("ORIG-07", I, r"your share of the words shown"), ("ORIG-07", C, r"\bShow \(Lines"),
    # ORIG-08  the AI pane
    ("ORIG-08", I, r"show or fix"), ("ORIG-08", I, r"keep it tidy"), ("ORIG-08", I, r"tell (cortex|your ai)"), ("ORIG-08", I, r"\breceipts?\b"),
    ("ORIG-08", C, r"\bShow me\b"), ("ORIG-08", C, r"\bFix it\b"),
    # ORIG-09  the tour
    ("ORIG-09", I, r"(take|start|skip) the tour"), ("ORIG-09", I, r"\bskip tour\b"), ("ORIG-09", I, r"watch it grow"),
    # ORIG-10  palettes and themes
    ("ORIG-10", C, r"\b(Glacier|Kiln|Nebula|Chalk|Spectrum|Tide|Moss|Borealis|Pewter|Dusk|Harbour|Basalt|Fern|Mulberry|Abyss|Smoke)\b"),
    # ORIG-11  the lab
    ("ORIG-11", I, r"your own lines"), ("ORIG-11", I, r"only lines you wrote"), ("ORIG-11", I, r"who read your record"), ("ORIG-11", I, r"what they labelled"),
    ("ORIG-11", I, r"and what it cost"), ("ORIG-11", I, r"belong to (replaced|superseded) versions"), ("ORIG-11", I, r"\brefused\b"), ("ORIG-11", I, r"\bunanswered\b"),
    ("ORIG-11", I, r"never read:"), ("ORIG-11", I, r"\blabelled \d+ ?%|\d+ ?% labelled"), ("ORIG-11", C, r"\bTags \d+ ?%"), ("ORIG-11", C, r"\bChecked \d+ ?%"),
    # ORIG-12  the entry reader
    ("ORIG-12", I, r"\b(someone else|assistant|an assistant)'s words"), ("ORIG-12", I, r"\bwritten by you\b"), ("ORIG-12", I, r"added to your record"),
    ("ORIG-12", I, r"written [^<\n]{0,40}· added"), ("ORIG-12", I, r"what the date proves"), ("ORIG-12", I, r"no labels yet"), ("ORIG-12", I, r"· shares "),
    ("ORIG-12", I, r"used by models"), ("ORIG-12", C, r"\bVersions \("), ("ORIG-12", I, r"save a copy"), ("ORIG-12", I, r"built from \d+ entries"),
    ("ORIG-12", I, r"read and made by"),
    # ORIG-13  the view popover
    ("ORIG-13", C, r"\bTurning\b"), ("ORIG-13", I, r"limit rotation"), ("ORIG-13", C, r"\bSpread\b"), ("ORIG-13", I, r"point size"), ("ORIG-13", C, r"\bThreads\b"),
    ("ORIG-13", I, r"ask conversations"), ("ORIG-13", I, r"labels on the brain"), ("ORIG-13", C, r"\bArrangement\b"), ("ORIG-13", I, r"own chats"),
    # ORIG-14  the dimension menu
    ("ORIG-14", C, r"\bWhere it is\b"), ("ORIG-14", C, r"\bWho and how\b"), ("ORIG-14", C, r"\bWhen added\b"), ("ORIG-14", I, r"hour of the day"),
    ("ORIG-14", I, r"month of the year"), ("ORIG-14", I, r"notes or record"), ("ORIG-14", C, r"\bMore labels \("), ("ORIG-14", C, r"\bUnsorted\b"),
    ("ORIG-14", I, r"\b(day|week|month|year) added\b"), ("ORIG-14", C, r"\bWhat it is\b"),
    # ORIG-15  the label schema
    ("ORIG-15", I, r"\bshel(f|ves|fs)\b"), ("ORIG-15", I, r"correction kind"), ("ORIG-15", I, r"makes (no )?claims"), ("ORIG-15", I, r"\bleft open\b"),
    ("ORIG-15", I, r"anatomical role"), ("ORIG-15", C, r"\b[Hh]ubs?\b"),
    # ORIG-18  the sparse banner
    ("ORIG-18", I, r"too few items to group"), ("ORIG-18", I, r"about \d+ (each|labelled)"), ("ORIG-18", I, r"labelled items per group"),
    ("ORIG-18", I, r"import more"), ("ORIG-18", I, r"see it on a sample"),
    # ORIG-19  the line legend
    ("ORIG-19", I, r"sequence chain"), ("ORIG-19", I, r"label tether"), ("ORIG-19", I, r"cross-link"), ("ORIG-19", I, r"parent line"), ("ORIG-19", I, r"hub spoke"),
    ("ORIG-19", C, r"\bThe lines\b"), ("ORIG-19", I, r"label lightning"), ("ORIG-19", I, r"layout chain"),
    # ORIG-20  page names. The left rail gives every destination of the recordings its own item, but under Cortex's
    # own names (Read, Data, Time, Yours, Checks, Agents, Guide, Ask, All pages). Never remove these bans to fit a
    # label or a layout name: rename it instead.
    ("ORIG-20", C, r"\b(Navigator|Numbers|Learn|Lab|Review|Show everything|Table builder)\b"),
    ("ORIG-08", C, r"\bYour AI\b"),
    # ORIG-22  the navigator row
    ("ORIG-22", I, r"claude code · conversation"),
    # ORIG-23  layouts
    ("ORIG-23", I, r"month grid"), ("ORIG-23", I, r"year (ring|wheel)"), ("ORIG-23", C, r"\bBrain regions\b"), ("ORIG-23", I, r"folder tree"),
    # ORIG-24  transcribed example values
    ("ORIG-24", C, r"\b41 ?%"), ("ORIG-24", C, r"\b38 ?%"), ("ORIG-24", I, r"\b38 entries\b"),
    # ORIG-25  the highlight verb
    ("ORIG-25", I, r"\b\d[\d,]* lit\b"), ("ORIG-25", C, r"\bLit \d"), ("ORIG-25", I, r"\blight (these|its sources|everything like this|the group|results|it)\b"),
    ("ORIG-25", I, r"in the brain\b.*\blight|\blight\b.*in the brain"),
    # names
    ("names", I, r"mindcorpus|mindsight|neuraxis|--nx-"),
]
PATTERNS = [(fid, re.compile(rx, flags)) for fid, flags, rx in BANNED]

def visible_text(path, raw):
    if path.endswith((".html", ".htm")):
        raw = re.sub(r"<style.*?</style>", " ", raw, flags=re.S)
        raw = re.sub(r"data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+", " ", raw)
        attrs = " ".join(re.findall(r'(?:title|aria-label|placeholder|alt)="([^"]*)"', raw))
        raw = re.sub(r"<[^>]+>", " ", raw) + "\n" + attrs
    return raw

def check(paths):
    hits = 0
    for p in paths:
        raw = open(p, encoding="utf-8").read()
        for n, line in enumerate(visible_text(p, raw).splitlines(), 1):
            for fid, rx in PATTERNS:
                m = rx.search(line)
                if m:
                    hits += 1
                    print(f"{os.path.basename(p)}:{n}: [{fid}] '{m.group(0)}' in: {line.strip()[:110]}")
    return hits

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    files = sys.argv[1:] or [os.path.join(here, "..", "main.html"), os.path.join(here, "..", "panels.html")]
    n = check(files)
    print(f"{n} banned expression(s) in {len(files)} file(s)" if n else f"clean: {len(files)} file(s), {len(PATTERNS)} patterns")
    sys.exit(1 if n else 0)
