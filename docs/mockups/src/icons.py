"""Small original stroke icon set for the Cortex mockups (24x24, stroke 1.75)."""
import math

def _cog():
    pts = []
    teeth = 8
    for i in range(teeth * 4):
        a = (i / (teeth * 4)) * 2 * math.pi - math.pi / 2
        r = 9.2 if (i % 4) in (1, 2) else 7.0
        pts.append((12 + r * math.cos(a), 12 + r * math.sin(a)))
    d = "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z"
    return f'<path d="{d}"/><circle cx="12" cy="12" r="2.8"/>'

GLYPH = ('<path d="M19.09 6.46A9 9 0 1 0 19.09 17.54"/>'
         '<path d="M16.83 10.71A5 5 0 1 0 12.44 16.98"/>'
         '<circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none"/>')

I = {
    "glyph": GLYPH,
    "search": '<circle cx="11" cy="11" r="6.3"/><path d="M15.7 15.7l4.6 4.6"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "cog": _cog(),
    "more": '<circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none"/>',
    "chev": '<path d="M7 10l5 5 5-5"/>',
    "chevr": '<path d="M10 7l5 5-5 5"/>',
    "sliders": '<path d="M4 7.5h9M17.5 7.5H20M4 16.5h3M11.5 16.5H20"/><circle cx="15.2" cy="7.5" r="2.2"/><circle cx="9.2" cy="16.5" r="2.2"/>',
    "chart": '<path d="M4 20h16"/><path d="M7 16.5V11M11 16.5V6.5M15 16.5v-4M19 16.5V9"/>',
    "tag": '<path d="M3.8 12V4.8h7.2l9.2 9.2-7.2 7.2z"/><circle cx="8.2" cy="9.2" r="1.3"/>',
    "lines": '<path d="M5 18c4.5 0 3.5-11 8-11 3.6 0 3.4 7 6.5 8"/><circle cx="5" cy="18" r="1.6"/><circle cx="19.5" cy="15" r="1.6"/>',
    "turn": '<path d="M19.2 12a7.2 7.2 0 1 1-2.1-5.1"/><path d="M19.4 4.6v3.9h-3.9"/>',
    "home": '<path d="M4 11l8-6.5 8 6.5V20h-5.4v-5.2H9.4V20H4z"/>',
    "max": '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    "x": '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    "pin": '<path d="M12 15.5V21M8.2 3.8h7.6l-1.4 5 3.1 3.6H6.5l3.1-3.6z"/>',
    "target": '<circle cx="12" cy="12" r="6.3"/><path d="M12 2.6v4M12 17.4v4M2.6 12h4M17.4 12h4"/>',
    "clock": '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.6V12l3 2"/>',
    "back": '<path d="M19 12H5.5M11 6l-6 6 6 6"/>',
    "check": '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
    "undo": '<path d="M9 6.8L4.6 11.2 9 15.6"/><path d="M5 11.2h9.2a4.9 4.9 0 0 1 0 9.8H11"/>',
    "play": '<path d="M8.5 5.8v12.4l9.6-6.2z"/>',
    "pause": '<path d="M9 6v12M15 6v12"/>',
    "upload": '<path d="M12 15.5V4.6M7.2 9.2L12 4.4l4.8 4.8M4.6 19.4h14.8"/>',
    "folder": '<path d="M3.6 6.4h5.8l2 2.1h9v10.7H3.6z"/>',
    "file": '<path d="M6 3.6h7.8L18 7.8v12.6H6z"/><path d="M13.6 3.8v4.2h4.2"/>',
    "msg": '<path d="M4.4 5h15.2v10.6H10l-5.6 4.2z"/>',
    "pulse": '<path d="M3 12.5h4l2.4-6.2 5 12.2 2.6-6h4"/>',
    "shield": '<path d="M12 3.4l7.4 3v5.6c0 4.5-3.1 7.5-7.4 8.9-4.3-1.4-7.4-4.4-7.4-8.9V6.4z"/>',
    "layers": '<path d="M12 4.2l8.6 4.8L12 13.8 3.4 9z"/><path d="M3.4 14l8.6 4.8 8.6-4.8"/>',
    "eye": '<path d="M2.6 12s3.4-6.4 9.4-6.4 9.4 6.4 9.4 6.4-3.4 6.4-9.4 6.4S2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.6"/>',
    "body": '<circle cx="12" cy="5.4" r="3"/><path d="M12 8.4v12.4"/><path d="M12 11.2l-4.8 2.3M12 11.2l4.8 2.3M12 14.6l-4.2 2.2M12 14.6l4.2 2.2M12 18l-3 1.9M12 18l3 1.9"/>',
    "groups": '<circle cx="7.2" cy="9" r="3.2"/><circle cx="16.6" cy="7.6" r="2.4"/><circle cx="13.2" cy="16.4" r="3.6"/>',
    "ext": '<path d="M13.8 4.6h5.6v5.6M19.4 4.6L11 13M17 13.8v5.6H4.6V7h5.6"/>',
    "list": '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="5" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="17" r="1" fill="currentColor" stroke="none"/>',
    "calendar": '<rect x="4" y="5.6" width="16" height="14.4" rx="1.6"/><path d="M4 10h16M8.4 3.6v4M15.6 3.6v4"/>',
    "book": '<path d="M4.4 5.6c3-1 5.6-.8 7.6.6v12.6c-2-1.4-4.6-1.6-7.6-.6z"/><path d="M19.6 5.6c-3-1-5.6-.8-7.6.6v12.6c2-1.4 4.6-1.6 7.6-.6z"/>',
    "inbox": '<path d="M4 13.4l2.6-7.8h10.8l2.6 7.8V19H4z"/><path d="M4 13.4h4.8l1.2 2h4l1.2-2H20"/>',
    "chip": '<rect x="7" y="7" width="10" height="10" rx="1.6"/><path d="M9.6 3.6V7M14.4 3.6V7M9.6 17v3.4M14.4 17v3.4M3.6 9.6H7M3.6 14.4H7M17 9.6h3.4M17 14.4h3.4"/>',
    "user": '<circle cx="12" cy="8.4" r="3.6"/><path d="M5 20c.8-3.8 3.6-5.8 7-5.8s6.2 2 7 5.8"/>',
    "refresh": '<path d="M19.4 11a7.4 7.4 0 0 0-13-4.2L4.6 8.6"/><path d="M4.6 4.4v4.2h4.2"/><path d="M4.6 13a7.4 7.4 0 0 0 13 4.2l1.8-1.8"/><path d="M19.4 19.6v-4.2h-4.2"/>',
    "comment": '<path d="M4.4 5h15.2v10.6H10l-5.6 4.2z"/><path d="M8.4 9.4h7.2M8.4 12.2h4.4"/>',
    "history": '<path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.2"/><path d="M4.4 4.6v3.6H8"/><path d="M12 8.2V12l2.6 1.6"/>',
    "drop": '<path d="M12 3.8v11M7.4 10.6L12 15.2l4.6-4.6M4.6 19.6h14.8"/>',
    "warn": '<path d="M12 4.2L21 19.6H3z"/><path d="M12 10v4.4"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
    "dot3": '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    "edit": '<path d="M5 19l1-4.2L15.6 5.2l3.2 3.2L9.2 18z"/><path d="M13.6 7.2l3.2 3.2"/>',
    "copy": '<rect x="8.4" y="8.4" width="11" height="11" rx="1.6"/><path d="M15.6 8.4V4.6H4.6v11h3.8"/>',
    "branch": '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 3.6-6 3-9.6 5"/>',
    "spark": '<path d="M12 4.5v15M4.5 12h15"/><path d="M7 7l10 10M17 7L7 17" opacity=".55"/>',
    "help": '<circle cx="12" cy="12" r="8.4"/><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6"/><circle cx="12" cy="16.9" r=".9" fill="currentColor" stroke="none"/>',
    "flag": '<path d="M5.6 20.4V4.2"/><path d="M5.6 4.8h11.2l-2.4 4 2.4 4H5.6"/>',
    "image": '<rect x="3.8" y="5" width="16.4" height="14" rx="1.8"/><circle cx="9" cy="10" r="1.6"/><path d="M4.4 17.4l5.2-4.6 3.6 3 2.6-2.2 4 3.6"/>',
    "clip": '<rect x="6.4" y="5.2" width="11.2" height="15" rx="1.6"/><path d="M9.4 5.2V3.8h5.2v1.4M9.2 10.4h5.6M9.2 13.6h5.6M9.2 16.8h3.4"/>',
    "slash": '<path d="M15.6 4.4L8.4 19.6"/>',
    "pen": '<path d="M5 19l1-4.2L15.6 5.2l3.2 3.2L9.2 18z"/><path d="M12.4 19.4h7"/>',
    "sun": '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.6v2M12 18.4v2M3.6 12h2M18.4 12h2M6.1 6.1l1.4 1.4M16.5 16.5l1.4 1.4M6.1 17.9l1.4-1.4M16.5 7.5l1.4-1.4"/>',
    "lock": '<rect x="5.4" y="10.4" width="13.2" height="9.6" rx="1.6"/><path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4"/>',
}

def svg(name, size=16, cls="", sw=1.75, extra=""):
    return (f'<svg class="ic {cls}" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
            f'stroke="currentColor" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" '
            f'aria-hidden="true" {extra}>{I[name]}</svg>')
