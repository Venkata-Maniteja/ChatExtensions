# chrome-extension — M365 Copilot Bridge (browser side)

Chrome MV3 extension that connects to the VS Code extension over a localhost
WebSocket and drives the M365 Copilot web UI on its behalf. See the top-level
[`../README.md`](../README.md) for full architecture.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Click the extension's options icon and set port + (optional) shared token to
   match the VS Code extension's settings.

The badge on the toolbar icon shows the WS state — green `ON` when connected,
grey `OFF` when not.

## Files

- `manifest.json` — MV3 declaration, host permissions for both Copilot
  hostnames, background service worker + content script.
- `background.js` — WS client, reconnect loop, tab routing, keep-alive alarm.
- `content.js` — DOM driver. **This is the file you'll edit when the UI
  changes.** Selectors live at the top in a `SELECTORS` object — each is an
  array of candidates tried in order.
- `protocol.js` — frame-type constants. Mirror of the TypeScript file on the
  VS Code side.
- `options.html` / `options.js` — settings UI.

## When the scraper stops working

Open the Copilot tab, open DevTools, watch the console for `[m365-bridge]`
log lines. Common failure modes:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Could not find composer input" | `SELECTORS.input` is stale | Inspect the composer; add the new selector to the top of the list. |
| "Could not find send button" | `SELECTORS.sendButton` is stale | Same as above for the send button. The Enter-key fallback usually still works. |
| Response arrives all at once, not streamed | `assistantBubble` matches the wrong node (e.g. a parent that's only added at the end) | Inspect the live message node while it's generating; tighten the selector. |
| "Timed out waiting for assistant bubble" | New bubble doesn't appear in the DOM under the selectors we know | Find the new bubble node, add its selector. |
| Stream never resolves to "done" | `stopGenerating` selector is stale | Inspect during generation; the button is usually a circle/stop icon next to the composer. |

Every selector is **additive** — add new candidates, don't remove old ones, so
the script keeps working across A/B variants.

## Security caveats

- WS connects to `127.0.0.1` only, so external machines can't reach it.
- Anything else running as your user on your machine can though. Set a shared
  token in both the VS Code setting and the options page to mitigate.
- The content script reads visible Copilot output and forwards it to the WS.
  Don't paste anything into Copilot that you don't want passing through your
  local pipeline.
