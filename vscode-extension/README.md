# vscode-extension — M365 Copilot Bridge (VS Code side)

Registers the `@m365` chat participant in the VS Code Chat panel and hosts a
WebSocket server on `127.0.0.1` that the companion Chrome extension connects
to. See the repo-level [`../README.md`](../README.md) for full architecture.

## Build & run (development)

```bash
npm install
npm run compile         # one-shot build
npm run watch           # incremental rebuild
```

Then open this folder in VS Code and press **F5** to launch an Extension
Development Host. The participant appears as `@m365` in the Chat panel.

## Files

- `src/extension.ts` — activation, status bar, command registration.
- `src/bridgeServer.ts` — WebSocket server on `127.0.0.1`, pending-request
  map, single-browser-client policy.
- `src/chatParticipant.ts` — implements the `vscode.ChatRequestHandler`. Uses
  snapshot-diffing so we can stream tokens even though the browser sends full
  text snapshots on every DOM mutation.
- `src/protocol.ts` — shared frame types (mirror `chrome-extension/protocol.js`).

## Settings

See `package.json` → `contributes.configuration`. The two you'll touch most:

- `m365Bridge.port` — change if `39847` collides with something.
- `m365Bridge.sharedToken` — set to harden the WS handshake (see top-level
  README).
