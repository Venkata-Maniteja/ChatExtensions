// Selector candidates for the M365 Copilot chat UI at m365.cloud.microsoft/chat.
// Each list is tried in order; first match wins. Add candidates rather than
// replacing — that way the driver survives A/B variants of the UI.
//
// To debug a broken selector, open the M365 Copilot tab, then DevTools →
// Elements, find the right node, and add its selector at the TOP of the
// appropriate list below.

export interface SelectorSet {
  input: string[];
  sendButton: string[];
  assistantBubble: string[];
  stopGenerating: string[];
  newChat: string[];
}

export const SELECTORS: SelectorSet = {
  input: [
    'textarea[data-testid="chat-input"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Ask" i]',
    'div[contenteditable="true"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]:not([disabled])',
    'button[title*="Send" i]:not([disabled])',
    'button[type="submit"]:not([disabled])',
  ],
  assistantBubble: [
    '[data-author="assistant"]',
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant-message"]',
    '[aria-roledescription*="assistant" i]',
  ],
  stopGenerating: [
    'button[aria-label*="Stop" i]',
    'button[data-testid="stop-button"]',
  ],
  newChat: [
    'button[aria-label*="New chat" i]',
    'button[data-testid="new-chat"]',
  ],
};
