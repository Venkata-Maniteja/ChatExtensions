// MV3 service worker. Maintains a WebSocket to the VS Code extension and
// routes frames between the WS and the content script(s).
//
// Notes on MV3 lifetime: an idle service worker is killed after ~30 seconds.
// Active WebSocket traffic resets the idle timer (Chrome ≥ 116), so as long
// as either side is sending frames the worker stays alive. We also use
// chrome.alarms as a defensive keep-alive.

import { FRAME } from './protocol.js';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 39847,
  token: '',
};

const HOST_MATCH = [
  'https://copilot.cloud.microsoft/*',
  'https://m365.cloud.microsoft/*',
];

let ws = null;
let reconnectTimer = null;
let connected = false;

async function loadSettings() {
  const stored = await chrome.storage.local.get(['port', 'token']);
  return {
    host: DEFAULTS.host,
    port: stored.port || DEFAULTS.port,
    token: stored.token || DEFAULTS.token,
  };
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const { host, port, token } = await loadSettings();
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `ws://${host}:${port}${qs}`;
  console.log('[m365-bridge:bg] connecting', url);

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.warn('[m365-bridge:bg] WS construct failed', e);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    connected = true;
    console.log('[m365-bridge:bg] WS open');
    ws.send(JSON.stringify({ type: FRAME.HELLO, role: 'browser', token }));
    setBadge('ON', '#3fb950');
  });

  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerFrame(msg);
  });

  ws.addEventListener('close', ev => {
    connected = false;
    console.log('[m365-bridge:bg] WS closed', ev.code, ev.reason);
    setBadge('OFF', '#8b949e');
    scheduleReconnect();
  });

  ws.addEventListener('error', err => {
    console.warn('[m365-bridge:bg] WS error', err);
    // 'close' will fire after, which triggers reconnect.
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* action API may not be ready during startup */ }
}

async function handleServerFrame(msg) {
  switch (msg.type) {
    case FRAME.PROMPT:
      await dispatchToTab(msg);
      return;
    case FRAME.CANCEL:
      await broadcastToTabs(msg);
      return;
    default:
      console.log('[m365-bridge:bg] ignored server frame', msg);
  }
}

async function findCopilotTab() {
  const tabs = await chrome.tabs.query({ url: HOST_MATCH });
  if (!tabs.length) return null;
  // Prefer the active/focused tab; otherwise first match.
  const focused = tabs.find(t => t.active) || tabs[0];
  return focused;
}

async function dispatchToTab(promptFrame) {
  const tab = await findCopilotTab();
  if (!tab) {
    sendToServer({
      type: FRAME.RESPONSE_ERROR,
      id: promptFrame.id,
      message:
        'No copilot.cloud.microsoft tab is open. Open it, sign in, and try again.',
    });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, promptFrame);
  } catch (e) {
    // Content script may not be alive yet — inject and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await chrome.tabs.sendMessage(tab.id, promptFrame);
    } catch (e2) {
      sendToServer({
        type: FRAME.RESPONSE_ERROR,
        id: promptFrame.id,
        message: `Could not reach Copilot tab: ${e2?.message || e2}`,
      });
    }
  }
}

async function broadcastToTabs(frame) {
  const tabs = await chrome.tabs.query({ url: HOST_MATCH });
  for (const t of tabs) {
    try { await chrome.tabs.sendMessage(t.id, frame); } catch { /* ignore */ }
  }
}

function sendToServer(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[m365-bridge:bg] dropping frame, WS not open', frame.type);
    return;
  }
  ws.send(JSON.stringify(frame));
}

// Content script → background relay.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && typeof msg.type === 'string' && msg.type.startsWith('response.')) {
    sendToServer(msg);
  }
  // Allow async sendResponse if needed in the future.
  return false;
});

// Keep-alive: ping every 25s while connected (well under the 30s SW idle).
chrome.alarms.create('m365-bridge-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'm365-bridge-keepalive') return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
  }
});

// First connect on install & on browser start.
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
connect();
