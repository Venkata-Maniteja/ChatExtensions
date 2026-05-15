// Shared message types between the VS Code extension (this side) and the
// Chrome extension (background.js + content.js). Keep this file's shape in
// sync with chrome-extension/protocol.js — they are the contract.

export type PromptFrame = {
  type: 'prompt';
  id: string;
  text: string;
};

export type CancelFrame = {
  type: 'cancel';
  id: string;
};

export type HelloFrame = {
  type: 'hello';
  role: 'browser';
  // Optional: token presented by the Chrome extension for handshake.
  token?: string;
};

export type ResponseDeltaFrame = {
  type: 'response.delta';
  id: string;
  // The FULL text seen so far in the assistant bubble, not a token diff.
  text: string;
};

export type ResponseDoneFrame = {
  type: 'response.done';
  id: string;
  text: string;
};

export type ResponseErrorFrame = {
  type: 'response.error';
  id: string;
  message: string;
};

export type ServerToClient = PromptFrame | CancelFrame;
export type ClientToServer =
  | HelloFrame
  | ResponseDeltaFrame
  | ResponseDoneFrame
  | ResponseErrorFrame;
