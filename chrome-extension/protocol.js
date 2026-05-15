// Mirror of vscode-extension/src/protocol.ts. Keep the shapes in sync.
//
// Server (VS Code) → Client (Chrome):
//   { type: 'prompt', id, text }
//   { type: 'cancel', id }
//
// Client (Chrome) → Server (VS Code):
//   { type: 'hello',           role: 'browser', token? }
//   { type: 'response.delta',  id, text }   // FULL snapshot, not a diff
//   { type: 'response.done',   id, text }
//   { type: 'response.error',  id, message }

export const FRAME = {
  PROMPT: 'prompt',
  CANCEL: 'cancel',
  HELLO: 'hello',
  RESPONSE_DELTA: 'response.delta',
  RESPONSE_DONE: 'response.done',
  RESPONSE_ERROR: 'response.error',
};
