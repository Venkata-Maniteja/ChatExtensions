// Injected into copilot.cloud.microsoft / m365.cloud.microsoft.
//
// Responsibilities:
//   1. Receive { type: 'prompt', id, text } messages from the background.
//   2. Drive the chat UI: type into the composer, dispatch send.
//   3. MutationObserver on the conversation pane — emit response.delta with
//      the FULL current text of the latest assistant message each time it
//      changes.
//   4. Detect "done" (Stop button disappears / Regenerate appears) and emit
//      response.done.
//
// IMPORTANT — this is the brittle layer. Microsoft does not provide stable
// hooks for this UI. The selectors below are a best-effort list of candidates
// and will need updating when the UI changes. To debug, open DevTools on the
// Copilot tab; every step logs with the `[m365-bridge]` prefix.

(() => {
  // Avoid double-install if the script is injected manually after a content
  // script auto-injection.
  if (window.__m365BridgeInstalled) return;
  window.__m365BridgeInstalled = true;

  const TAG = '[m365-bridge]';
  const log = (...args) => console.log(TAG, ...args);
  const warn = (...args) => console.warn(TAG, ...args);

  // ----- Selector candidates ---------------------------------------------
  // Each list is tried in order; first match wins. Add candidates — don't
  // delete — so we survive A/B variants.
  const SELECTORS = {
    // Composer input — either a textarea or a contenteditable.
    input: [
      'textarea[data-testid="chat-input"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"]',
    ],
    // Send / submit button.
    sendButton: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]:not([disabled])',
      'button[title*="Send" i]:not([disabled])',
      'button[type="submit"]:not([disabled])',
    ],
    // The container that holds the message thread (so we can find the LAST
    // assistant message). We use a generous fallback to "the largest list-y
    // ancestor of an assistant role node".
    threadContainer: [
      '[data-testid="chat-thread"]',
      'main [role="log"]',
      'main',
    ],
    // Individual message bubbles authored by the assistant.
    assistantBubble: [
      '[data-author="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant-message"]',
      '[aria-roledescription*="assistant" i]',
    ],
    // Signals that the model is still generating.
    stopGenerating: [
      'button[aria-label*="Stop" i]',
      'button[data-testid="stop-button"]',
    ],
    // Optional: "New chat" trigger if newChatPerRequest is enabled.
    newChat: [
      'button[aria-label*="New chat" i]',
      'button[data-testid="new-chat"]',
    ],
  };

  function pick(list) {
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function pickAll(list) {
    for (const sel of list) {
      const els = document.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    }
    return [];
  }

  // ----- Driving the UI --------------------------------------------------

  async function setComposerText(text) {
    const el = pick(SELECTORS.input);
    if (!el) throw new Error('Could not find composer input. Update SELECTORS.input.');

    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // For React-controlled inputs, set value via the native setter so React
      // notices the change.
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    log('composer set to', JSON.stringify(text.slice(0, 80)));
  }

  async function clickSend() {
    // Many UIs only enable the send button after a microtask. Retry briefly.
    for (let i = 0; i < 20; i++) {
      const btn = pick(SELECTORS.sendButton);
      if (btn && !btn.disabled) {
        btn.click();
        log('send clicked');
        return;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    // Last resort: simulate Enter keypress in the composer.
    const el = pick(SELECTORS.input);
    if (el) {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true,
      }));
      log('sent via Enter keypress');
      return;
    }
    throw new Error('Could not find send button. Update SELECTORS.sendButton.');
  }

  async function maybeStartNewChat() {
    // Controlled by m365Bridge.newChatPerRequest, surfaced via storage.
    const { newChatPerRequest } = await chrome.storage.local.get('newChatPerRequest');
    if (!newChatPerRequest) return;
    const btn = pick(SELECTORS.newChat);
    if (btn) {
      btn.click();
      log('clicked New chat');
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // ----- Observing the response ----------------------------------------

  /**
   * Returns the LAST assistant bubble currently in the DOM, or null.
   */
  function latestAssistantBubble() {
    const bubbles = pickAll(SELECTORS.assistantBubble);
    return bubbles.length ? bubbles[bubbles.length - 1] : null;
  }

  function isGenerating() {
    return !!pick(SELECTORS.stopGenerating);
  }

  /**
   * Wait for a NEW assistant bubble to appear after sending. We snapshot the
   * count of bubbles immediately before sending, and resolve when the count
   * goes up — or when the existing last bubble starts changing.
   */
  function waitForNewAssistantBubble(preSendCount, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const bubbles = pickAll(SELECTORS.assistantBubble);
        if (bubbles.length > preSendCount) {
          resolve(bubbles[bubbles.length - 1]);
          return;
        }
        // Some UIs reuse the last bubble — if it's clearly being mutated,
        // accept it.
        const last = bubbles[bubbles.length - 1];
        if (last && isGenerating()) {
          resolve(last);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Timed out waiting for assistant bubble to appear.'));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /**
   * Stream snapshots of `bubble.innerText` until generation completes.
   */
  function streamUntilDone(bubble, requestId, cancelSignal) {
    return new Promise((resolve, reject) => {
      let lastSnapshot = '';
      let doneCheckTimer = null;
      let stallTimer = null;
      const STALL_MS = 20_000;

      const sendDelta = () => {
        const snap = (bubble.innerText || '').trim();
        if (snap && snap !== lastSnapshot) {
          lastSnapshot = snap;
          chrome.runtime.sendMessage({
            type: 'response.delta',
            id: requestId,
            text: snap,
          });
          resetStall();
        }
      };

      const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          // No mutations in a while AND not generating → call it done.
          if (!isGenerating()) finish();
        }, STALL_MS);
      };

      const finish = () => {
        cleanup();
        chrome.runtime.sendMessage({
          type: 'response.done',
          id: requestId,
          text: lastSnapshot,
        });
        resolve();
      };

      const fail = msg => {
        cleanup();
        chrome.runtime.sendMessage({
          type: 'response.error',
          id: requestId,
          message: msg,
        });
        reject(new Error(msg));
      };

      const cleanup = () => {
        clearInterval(doneCheckTimer);
        clearTimeout(stallTimer);
        observer.disconnect();
        cancelSignal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => fail('Cancelled by user.');
      cancelSignal.addEventListener('abort', onAbort);

      const observer = new MutationObserver(() => sendDelta());
      observer.observe(bubble, {
        characterData: true,
        childList: true,
        subtree: true,
      });

      // Poll for the generating state — switch from "generating" to "not
      // generating" is the cleanest done signal.
      let wasGenerating = isGenerating();
      doneCheckTimer = setInterval(() => {
        const gen = isGenerating();
        if (wasGenerating && !gen) {
          // One more snapshot for safety, then resolve.
          sendDelta();
          finish();
        }
        wasGenerating = gen;
      }, 400);

      // Emit an initial snapshot in case the bubble already has content.
      sendDelta();
      resetStall();
    });
  }

  // ----- Request lifecycle ---------------------------------------------

  const activeRequests = new Map(); // id -> AbortController

  async function handlePrompt(frame) {
    const { id, text } = frame;
    log('prompt received', id, text.slice(0, 60));
    const abort = new AbortController();
    activeRequests.set(id, abort);

    try {
      await maybeStartNewChat();
      const preCount = pickAll(SELECTORS.assistantBubble).length;
      await setComposerText(text);
      await clickSend();
      const bubble = await waitForNewAssistantBubble(preCount);
      await streamUntilDone(bubble, id, abort.signal);
    } catch (e) {
      warn('handlePrompt failed', e);
      chrome.runtime.sendMessage({
        type: 'response.error',
        id,
        message: e?.message || String(e),
      });
    } finally {
      activeRequests.delete(id);
    }
  }

  function handleCancel(frame) {
    const abort = activeRequests.get(frame.id);
    if (abort) abort.abort();
    // Also try to click the Stop button on the page so the model actually
    // stops burning tokens.
    const stop = pick(SELECTORS.stopGenerating);
    if (stop) stop.click();
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'prompt') handlePrompt(msg);
    else if (msg.type === 'cancel') handleCancel(msg);
  });

  log('content script installed');
})();
