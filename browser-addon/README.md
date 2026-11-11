# Cortex live capture (browser add-on)

A small Manifest V3 add-on for Chrome, Edge and Brave that sends each finished chat turn on the sites you approve to
Cortex, which must be running on the same computer. It talks to `http://127.0.0.1:<port>` only.

## Install by hand

1. In Cortex, open Sources, Live capture, read what is stored, and turn it on. Use "Save the add-on" and unzip it
   (or use this folder as it is).
2. In the browser open `chrome://extensions` (or `edge://extensions`), switch on Developer mode, choose
   "Load unpacked" and pick the folder.
3. Open the add-on's options page. Paste the token from Cortex (Sources, Live capture, Copy token), keep the port in
   step with Cortex, and tick the sites you want. The browser asks for each site's permission; unticking removes it.
4. "Test the connection" should answer "Connected".

## What it does and does not do

- It reads the chat messages on the ticked sites only, waits until a reply has finished, and posts the turn
  (id, who said it, the text) to Cortex. Older messages already on screen are not sent unless you tick that option.
- Cortex refuses any post without the token, from anything but this computer, or for a site you have not approved
  there. Cortex counts what it refuses.
- Nothing is sent to any server. The token and options stay in this browser's local extension storage.
- The selectors that find messages live in `content.js` and can go out of date when a site changes its page.

## Files

`manifest.json`, `core.js` (which turns are finished), `content.js` (reads the page), `background.js` (posts to
Cortex), `options.html` and `options.js`. The same files are embedded in Cortex (`src/shared/captureAddon.ts`,
produced by `node scripts/embed-addon.mjs`); a test fails when the two differ.
