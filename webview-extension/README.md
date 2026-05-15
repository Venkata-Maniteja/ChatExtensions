# webview-extension — Web Chat in a VS Code panel

Opens an editor tab containing an iframe + URL bar. Whatever URL you load
runs in a webview, so you can sign in inside the panel and (if the site
allows it) chat without leaving VS Code.

> **Will this actually work for ChatGPT / M365 Copilot?**
> Probably not, and the failure mode is fast: the iframe will load blank or
> show a "this site can't be embedded" error. Both ChatGPT (`chatgpt.com`)
> and M365 Copilot (`copilot.cloud.microsoft`) send
> `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors
> 'none'`. Those headers are enforced by Electron's renderer and there is
> no extension-side override.
>
> Sites that *do* allow framing (most documentation sites, internal tools,
> some self-hosted LLM frontends) will work fine. This extension is also
> the right scaffold to try `https://` URLs from chat services that haven't
> hardened their framing headers yet.

## Build & install

```bash
cd webview-extension
npm install
npm run compile
```

### Run in dev mode (recommended for the experiment)
Open the folder in VS Code and press **F5**. An Extension Development Host
window opens. In it, run **Cmd-Shift-P → Web Chat: Open Panel**.

### Install permanently
```bash
npm install -g @vscode/vsce              # one-time
vsce package --allow-missing-repository
code --install-extension ./web-chat-webview-0.0.1.vsix
```
If `vsce` complains about the publisher, edit `package.json` and change
`"publisher": "local"` to any unique string.

## Commands

| Command | What it does |
| --- | --- |
| `Web Chat: Open Panel` | Open the panel with the last URL you used (or the default). |
| `Web Chat: Open Panel with URL…` | Prompt for a URL, then open the panel pointing at it. |

The panel itself has back / forward / reload / Go buttons and an
"open in real browser" button (⎉ icon) for when framing is blocked.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `webChat.defaultUrl` | `https://chatgpt.com` | Used when no previous URL is remembered. |

## How to tell what's blocking it

1. Open the panel.
2. Command palette → **Developer: Open Webview Developer Tools**.
3. In the DevTools that opens, look at:
   - **Console**: framing refusals show up as
     `Refused to display 'https://...' in a frame because it set
     'X-Frame-Options' to 'deny'.` or similar CSP messages.
   - **Network**: the request to the page returns 200, but the response
     headers include `x-frame-options: deny` or
     `content-security-policy: frame-ancestors 'none'`.

If you see either of those, the site is refusing framing on purpose. Click
the ⎉ button to open the URL in your real browser instead.

## What this extension can't do

- **Override the target site's framing policy.** No.
- **Override the webview user-agent** so the site thinks it's a regular
  browser. VS Code doesn't expose that knob to extensions.
- **Share cookies with your system Chrome/Edge.** Webview cookies are
  isolated. You'll have to sign in separately inside the panel \u2014 and
  conditional access may then reject the webview session.
- **Persist auth across VS Code restarts.** Webview storage *does* persist
  (it's a separate Electron partition), so most session cookies will
  survive a reload. But conditional access often invalidates them.

## Files

- `src/extension.ts` \u2014 command registration, WebviewPanel lifecycle,
  globalState persistence of the last URL.
- `src/webview.ts` \u2014 generates the HTML (URL bar, iframe, CSP with nonce).
- `package.json` \u2014 commands + settings contributions.
