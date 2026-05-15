import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

/**
 * Builds the HTML that fills the WebviewPanel.
 *
 * Layout:
 *   [ ← → ⟳ ]  [ url input.................. ]  [ Go ] [ ⎈ external ]
 *   [ status line ]
 *   [ iframe — fills remaining space ]
 *
 * Notes on CSP:
 *   - `frame-src https:` allows the iframe to load any HTTPS URL.
 *   - `script-src 'nonce-XYZ'` so only our inline script runs.
 *   - This CSP is on the WEBVIEW document. The IFRAMED page enforces its
 *     own headers (X-Frame-Options, frame-ancestors) — if those forbid
 *     framing, the iframe will render blank or an error page. There is
 *     no extension-side override for that; it's the target site's call.
 */
export function getWebviewHtml(webview: vscode.Webview, initialUrl: string): string {
  const nonce = randomBytes(16).toString('base64');

  const csp = [
    `default-src 'none'`,
    `frame-src https:`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  const safeInitial = escapeAttr(initialUrl);
  const initialJson = JSON.stringify(initialUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Web Chat</title>
<style>
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .root { display: flex; flex-direction: column; height: 100%; }
  .bar {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
  }
  .bar button {
    padding: 4px 9px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; cursor: pointer; border-radius: 2px;
    font-size: 13px; line-height: 1; min-width: 28px;
  }
  .bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .bar button:disabled { opacity: 0.35; cursor: not-allowed; }
  .bar input {
    flex: 1; min-width: 0;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px; outline: none;
    font: inherit; font-size: 13px;
  }
  .bar input:focus { border-color: var(--vscode-focusBorder); }
  .bar .go {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    padding: 4px 12px;
  }
  .bar .go:hover { background: var(--vscode-button-hoverBackground); }
  .status {
    font-size: 11px;
    padding: 3px 10px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .status.error { color: var(--vscode-errorForeground); }
  .frame-wrap { flex: 1; position: relative; background: white; }
  iframe { width: 100%; height: 100%; border: 0; display: block; background: white; }
  .hint {
    position: absolute; inset: 0; display: none;
    padding: 24px; box-sizing: border-box;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-size: 13px; line-height: 1.5;
  }
  .hint code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 2px;
  }
  .hint.show { display: block; }
  .hint h3 { margin-top: 0; }
</style>
</head>
<body>
<div class="root">
  <div class="bar">
    <button id="back" title="Back">&larr;</button>
    <button id="fwd"  title="Forward">&rarr;</button>
    <button id="reload" title="Reload">&#x21BB;</button>
    <input id="url" type="text" value="${safeInitial}" placeholder="https://example.com" spellcheck="false" autocomplete="off" />
    <button id="go" class="go" title="Load URL (Enter)">Go</button>
    <button id="external" title="Open this URL in your real browser">&#x29C9;</button>
  </div>
  <div id="status" class="status">Idle.</div>
  <div class="frame-wrap">
    <iframe
      id="frame"
      src="${safeInitial}"
      referrerpolicy="no-referrer-when-downgrade"
      allow="clipboard-read; clipboard-write; autoplay; encrypted-media"
    ></iframe>
    <div id="hint" class="hint">
      <h3>The iframe didn't load.</h3>
      <p>If the panel is blank, the target site is almost certainly refusing to be embedded \u2014 it sent <code>X-Frame-Options: DENY</code> or <code>Content-Security-Policy: frame-ancestors 'none'</code>. Major chat providers (ChatGPT, M365 Copilot) do this on purpose.</p>
      <p>Try:</p>
      <ul>
        <li>Open <strong>Developer: Open Webview Developer Tools</strong> from the command palette and check the Console / Network tabs for the exact error.</li>
        <li>Click the <strong>&#x29C9;</strong> button above to open the URL in your real browser.</li>
        <li>Try a site that allows framing to confirm the extension itself works (e.g. <code>https://example.com</code>).</li>
      </ul>
    </div>
  </div>
</div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $url     = document.getElementById('url');
  const $frame   = document.getElementById('frame');
  const $status  = document.getElementById('status');
  const $back    = document.getElementById('back');
  const $fwd     = document.getElementById('fwd');
  const $reload  = document.getElementById('reload');
  const $go      = document.getElementById('go');
  const $ext     = document.getElementById('external');
  const $hint    = document.getElementById('hint');

  // History of EXPLICITLY navigated URLs (Go presses + back/forward).
  // We can't track inside-iframe navigation cross-origin.
  const history = [${initialJson}];
  let idx = 0;

  function setStatus(text, isError) {
    $status.textContent = text;
    $status.classList.toggle('error', !!isError);
  }

  function updateNav() {
    $back.disabled = idx <= 0;
    $fwd.disabled  = idx >= history.length - 1;
  }

  function normalize(raw) {
    raw = (raw || '').trim();
    if (!raw) return '';
    if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(raw)) raw = 'https://' + raw;
    try { new URL(raw); } catch { return ''; }
    return raw;
  }

  let loadTimer = null;
  function navigate(rawUrl, opts) {
    opts = opts || {};
    const url = normalize(rawUrl);
    if (!url) { setStatus('Invalid URL', true); return; }

    if (opts.pushHistory !== false) {
      history.splice(idx + 1);
      history.push(url);
      idx = history.length - 1;
    }
    $url.value = url;
    $hint.classList.remove('show');
    setStatus('Loading ' + url + ' \u2026');

    // The iframe's load event fires even on framing-blocked pages (with
    // about:blank). We use a timeout as a soft "did anything happen?" signal.
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      setStatus('Still waiting \u2014 the site may be refusing to load in an iframe.', true);
      $hint.classList.add('show');
    }, 6000);

    $frame.src = url;
    vscode.postMessage({ type: 'urlChanged', url });
    updateNav();
  }

  $go.addEventListener('click', () => navigate($url.value));
  $reload.addEventListener('click', () => {
    setStatus('Reloading\u2026');
    // Reassigning src triggers a fresh load.
    $frame.src = $frame.src;
  });
  $back.addEventListener('click', () => {
    if (idx > 0) { idx--; navigate(history[idx], { pushHistory: false }); }
  });
  $fwd.addEventListener('click', () => {
    if (idx < history.length - 1) { idx++; navigate(history[idx], { pushHistory: false }); }
  });
  $url.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigate($url.value); }
  });
  $ext.addEventListener('click', () => {
    vscode.postMessage({ type: 'openExternal', url: $url.value.trim() });
  });

  $frame.addEventListener('load', () => {
    clearTimeout(loadTimer);
    // We can't read the iframe's current URL cross-origin, so we can't tell
    // "loaded successfully" from "blocked by X-Frame-Options and rendered
    // about:blank" \u2014 both fire load. Show a neutral message; the user can
    // glance at the iframe to know.
    setStatus('Load event fired. If the panel is blank, the site refused framing \u2014 see Webview Developer Tools.');
  });

  // Extension \u2192 webview: { type: 'navigate', url }
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m && m.type === 'navigate' && typeof m.url === 'string') {
      navigate(m.url);
    }
  });

  updateNav();
})();
</script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
