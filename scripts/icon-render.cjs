// Run by Electron (scripts/make-icon.mjs starts it): draws the Cortex glyph on a dark rounded tile at every icon
// size and writes one PNG per size. Usage: electron scripts/icon-render.cjs <outDir> <size,size,...>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const outDir = process.argv[2];
const sizes = (process.argv[3] || "16,32,48,64,128,256,512").split(",").map(Number);
// The same three shapes as src/ui/icons.ts (24-unit master), scaled to fill the tile.
const svg = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1e27"/><stop offset="1" stop-color="#0d0f14"/></linearGradient></defs>
  <rect x="0.5" y="0.5" width="23" height="23" rx="5.2" fill="url(#g)" stroke="#2c303b" stroke-width="0.5"/>
  <g transform="translate(12 12) scale(1.02) translate(-12 -12)" fill="none" stroke="#b39bf6" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M19.09 6.46A9 9 0 1 0 19.09 17.54"/>
    <path d="M16.83 10.71A5 5 0 1 0 12.44 16.98"/>
    <circle cx="12" cy="12" r="1.65" fill="#b39bf6" stroke="none"/>
  </g></svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html;charset=utf-8,<!doctype html><meta charset=utf-8>");
    // Each size is rasterised by Chromium from the SVG itself (crisp at 16 px too), through a canvas.
    const script = `(async () => {
      const make = ${svg.toString()};
      const out = {};
      for (const px of ${JSON.stringify(sizes)}) {
        const img = new Image();
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(make(px));
        await img.decode();
        const c = document.createElement("canvas");
        c.width = px; c.height = px;
        c.getContext("2d").drawImage(img, 0, 0, px, px);
        out[px] = c.toDataURL("image/png").split(",")[1];
      }
      return out;
    })()`;
    const pngs = await win.webContents.executeJavaScript(script);
    for (const px of sizes) fs.writeFileSync(path.join(outDir, `icon-${px}.png`), Buffer.from(pngs[px], "base64"));
    win.destroy();
    app.exit(0);
  } catch (e) {
    console.error(String(e));
    app.exit(1);
  }
});
