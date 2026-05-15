# cdp-extension — VS Code chat ↔ real Chrome over CDP

Drives `https://m365.cloud.microsoft/chat` in your real Chrome by connecting to
its DevTools Protocol port. No Chrome extension required — you just launch
Chrome with one extra flag.

## How it works

```
   VS Code  ──┐
              │   vscode.chat (@m365cdp)
              ▼
   ┌────────────────────────────┐
   │   CdpDriver (Node, Playwright-core)
   │     ws → http://127.0.0.1:9222
   └──────────────┬─────────────┘
                  │ CDP
                  ▼
   ┌────────────────────────────┐
   │   Your real Chrome
   │   tab: m365.cloud.microsoft/chat
   │   (your existing login session)
   └────────────────────────────┘
```

Same scraping approach as `chrome-extension/content.js`, but the driver runs
inside the VS Code extension instead of inside Chrome. Selectors and the
done-detection heuristic are ported over verbatim.

## Setup

### 1. Launch Chrome with the debug port

Chrome refuses `--remote-debugging-port` if it's already running with your
normal profile, so use a *separate* profile:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir="$HOME/.chrome-cdp-profile"
```

```powershell
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-allow-origins=* `
  --user-data-dir="$env:USERPROFILE\.chrome-cdp-profile"
```

```bash
# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir="$HOME/.chrome-cdp-profile"
```

Sign in to `https://m365.cloud.microsoft/chat` once in this Chrome window.
The profile persists, so future launches with the same `--user-data-dir`
keep your session.

`--remote-allow-origins=*` is required on Chrome ≥ 111 for CDP clients to
attach. Tighten it to your machine's loopback origin if you're paranoid.

### 2. Install the extension (dev mode)

```bash
cd cdp-extension
npm install
npm run compile
```

Then in VS Code press **F5** to launch an Extension Development Host.

### 3. Try it

1. Run **M365 CDP Bridge: Test browser connection** from the command palette.
   You should see `Connected. Driving https://m365.cloud.microsoft/chat`.
2. Open the Chat panel → `@m365cdp hello, are you there?`

If the bubble appears but no text streams, the selectors are out of date —
update `src/selectors.ts`. See "Debugging selectors" below.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `m365CdpBridge.cdpEndpoint` | `http://127.0.0.1:9222` | Where Chrome is listening. |
| `m365CdpBridge.targetUrl` | `https://m365.cloud.microsoft/chat` | URL to drive. The extension picks the first tab whose host matches. |
| `m365CdpBridge.requestTimeoutMs` | `120000` | Per-prompt ceiling. |
| `m365CdpBridge.newChatPerRequest` | `false` | Click "New chat" before each prompt. |

## Debugging selectors

When the UI changes, the driver will fail with `Composer not found.` or
`Timed out waiting for assistant bubble.` To fix:

1. Open the M365 Copilot tab in your CDP Chrome.
2. DevTools → Elements, find the composer / send button / assistant bubble /
   stop button.
3. Add a working selector to the **top** of the matching list in
   [src/selectors.ts](src/selectors.ts) — don't delete existing ones, they
   may still match other variants.
4. `npm run compile` and reload the Extension Development Host.

## Caveats

- **Separate Chrome profile.** This won't share cookies with your daily Chrome.
  Sign in once inside the CDP-launched window and stay logged in there.
- **Conditional access.** Enterprise tenants may reject sessions from
  "unfamiliar" Chrome instances — same as the WS-bridge version.
- **Same scraping fragility.** Microsoft can re-skin the UI any time and
  break the selectors. The error surfaces in the chat panel — update
  `selectors.ts`.
- **Anyone on your machine can connect to port 9222.** Chrome's debug port
  has no auth. Don't enable it on shared / public machines.
