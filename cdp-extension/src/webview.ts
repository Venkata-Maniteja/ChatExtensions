import * as vscode from 'vscode';

// Generates the HTML for the chat webview. Self-contained: CSP-locked inline
// script + styles with a nonce. No external assets. The script speaks the
// message protocol defined in chatPanel.ts.
export function renderWebviewHtml(webview: vscode.Webview): string {
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  :root { color-scheme: var(--vscode-color-scheme); }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column;
  }
  #status {
    padding: 4px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px; color: var(--vscode-descriptionForeground);
    display: flex; align-items: center; gap: 8px;
  }
  #status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-red); }
  #status.connected .dot { background: var(--vscode-charts-green); }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .msg { margin: 0 0 12px 0; padding: 8px 10px; border-radius: 6px;
         border: 1px solid var(--vscode-panel-border); white-space: pre-wrap;
         word-wrap: break-word; line-height: 1.45; }
  .msg.user { background: var(--vscode-editorWidget-background); }
  .msg.assistant { background: var(--vscode-editor-background); }
  .msg.error { background: var(--vscode-inputValidation-errorBackground);
               color: var(--vscode-inputValidation-errorForeground);
               border-color: var(--vscode-inputValidation-errorBorder); }
  .role { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
          color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .msg pre { background: var(--vscode-textCodeBlock-background); padding: 8px;
             border-radius: 4px; overflow-x: auto; margin: 6px 0; }
  .msg code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  #composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px;
              display: flex; gap: 8px; align-items: flex-end; }
  #input {
    flex: 1; resize: none; min-height: 36px; max-height: 200px;
    padding: 8px 10px; border-radius: 4px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    font-family: inherit; font-size: inherit;
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button {
    height: 36px; padding: 0 14px; border: none; border-radius: 4px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    cursor: pointer; font-family: inherit; font-size: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <div id="status"><span class="dot"></span><span id="status-text">checking…</span></div>
  <div id="log" aria-live="polite"></div>
  <form id="composer" autocomplete="off">
    <textarea id="input" placeholder="Message M365 Copilot…  (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
    <button type="submit" id="send">Send</button>
    <button type="button" id="stop" class="secondary" hidden>Stop</button>
  </form>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $log = document.getElementById('log');
  const $input = document.getElementById('input');
  const $send = document.getElementById('send');
  const $stop = document.getElementById('stop');
  const $form = document.getElementById('composer');
  const $status = document.getElementById('status');
  const $statusText = document.getElementById('status-text');

  // Restore prior session state so the panel survives reloads.
  const prior = vscode.getState() || { messages: [] };
  let messages = Array.isArray(prior.messages) ? prior.messages : [];
  let inflight = null; // { id, bubble }

  function persist() { vscode.setState({ messages }); }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Minimal markdown: fenced code blocks + inline code. Everything else is
  // rendered as plain text with newlines preserved via white-space: pre-wrap.
  function renderMarkdown(text) {
    const parts = [];
    let i = 0;
    const fence = /\`\`\`([\\w-]*)\\n([\\s\\S]*?)\\n\`\`\`/g;
    let m;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > i) parts.push({ kind: 'text', body: text.slice(i, m.index) });
      parts.push({ kind: 'code', lang: m[1], body: m[2] });
      i = m.index + m[0].length;
    }
    if (i < text.length) parts.push({ kind: 'text', body: text.slice(i) });

    return parts.map(p => {
      if (p.kind === 'code') {
        return '<pre><code>' + escapeHtml(p.body) + '</code></pre>';
      }
      // inline code
      const body = escapeHtml(p.body).replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
      return body;
    }).join('');
  }

  function appendMessage(msg, scroll = true) {
    const div = document.createElement('div');
    div.className = 'msg ' + msg.role;
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = msg.role === 'user' ? 'You' :
                       msg.role === 'assistant' ? 'M365 Copilot' : 'Error';
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = renderMarkdown(msg.text || '');
    div.appendChild(role); div.appendChild(body);
    $log.appendChild(div);
    if (scroll) $log.scrollTop = $log.scrollHeight;
    return body;
  }

  function rehydrate() {
    $log.innerHTML = '';
    for (const m of messages) appendMessage(m, false);
    $log.scrollTop = $log.scrollHeight;
  }

  function setBusy(busy) {
    $send.disabled = busy;
    $input.disabled = busy;
    $stop.hidden = !busy;
  }

  function setStatus(connected, text) {
    $status.classList.toggle('connected', !!connected);
    $statusText.textContent = text;
  }

  rehydrate();
  vscode.postMessage({ type: 'ready' });

  $form.addEventListener('submit', e => {
    e.preventDefault();
    const text = $input.value.trim();
    if (!text || inflight) return;

    const userMsg = { role: 'user', text };
    messages.push(userMsg);
    appendMessage(userMsg);

    const assistant = { role: 'assistant', text: '' };
    messages.push(assistant);
    const bubble = appendMessage(assistant);

    const id = String(Date.now()) + '-' + Math.random().toString(16).slice(2, 8);
    inflight = { id, bubble, msg: assistant };
    setBusy(true);
    persist();

    $input.value = '';
    autoSize();
    vscode.postMessage({ type: 'prompt', id, text });
  });

  $stop.addEventListener('click', () => {
    if (!inflight) return;
    vscode.postMessage({ type: 'cancel', id: inflight.id });
  });

  $input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $form.requestSubmit();
    }
  });

  function autoSize() {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 200) + 'px';
  }
  $input.addEventListener('input', autoSize);

  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'delta' && inflight && m.id === inflight.id) {
      inflight.msg.text = m.snapshot;
      inflight.bubble.innerHTML = renderMarkdown(m.snapshot);
      $log.scrollTop = $log.scrollHeight;
      persist();
    } else if (m.type === 'done' && inflight && m.id === inflight.id) {
      if (m.text && m.text.length > (inflight.msg.text || '').length) {
        inflight.msg.text = m.text;
        inflight.bubble.innerHTML = renderMarkdown(m.text);
      }
      inflight = null;
      setBusy(false);
      persist();
    } else if (m.type === 'error') {
      const errText = m.message || 'Unknown error';
      if (inflight && m.id === inflight.id) {
        inflight.msg.role = 'error';
        inflight.msg.text = errText;
        inflight.bubble.parentElement.className = 'msg error';
        inflight.bubble.innerHTML = renderMarkdown(errText);
        inflight = null;
        setBusy(false);
      } else {
        const em = { role: 'error', text: errText };
        messages.push(em); appendMessage(em);
      }
      persist();
    } else if (m.type === 'status') {
      setStatus(m.connected, m.text || (m.connected ? 'connected' : 'disconnected'));
    }
  });
})();
</script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
