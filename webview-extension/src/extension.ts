import * as vscode from 'vscode';
import { getWebviewHtml } from './webview';

const PANEL_TYPE = 'webChat.panel';
const STATE_LAST_URL = 'webChat.lastUrl';

// We keep a singleton panel reference — opening the command twice focuses the
// existing panel instead of creating a duplicate.
let currentPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('webChat.open', () => {
      openPanel(context);
    }),
    vscode.commands.registerCommand('webChat.openCustom', async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'URL to load in the webview',
        placeHolder: 'https://chatgpt.com',
        value: context.globalState.get<string>(
          STATE_LAST_URL,
          vscode.workspace.getConfiguration('webChat').get<string>('defaultUrl', 'https://chatgpt.com'),
        ),
        validateInput: v => {
          if (!v.trim()) return 'URL required';
          try { new URL(v.includes('://') ? v : 'https://' + v); return null; }
          catch { return 'Invalid URL'; }
        },
      });
      if (!url) return;
      const normalized = url.includes('://') ? url : 'https://' + url;
      await context.globalState.update(STATE_LAST_URL, normalized);
      openPanel(context, normalized);
    }),
  );
}

export function deactivate(): void {
  currentPanel?.dispose();
  currentPanel = undefined;
}

function openPanel(context: vscode.ExtensionContext, urlOverride?: string): void {
  if (currentPanel) {
    currentPanel.reveal(currentPanel.viewColumn ?? vscode.ViewColumn.Active);
    if (urlOverride) {
      currentPanel.webview.postMessage({ type: 'navigate', url: urlOverride });
    }
    return;
  }

  const defaultUrl =
    vscode.workspace.getConfiguration('webChat').get<string>('defaultUrl', 'https://chatgpt.com');
  const initialUrl =
    urlOverride ?? context.globalState.get<string>(STATE_LAST_URL, defaultUrl);

  const panel = vscode.window.createWebviewPanel(
    PANEL_TYPE,
    'Web Chat',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      enableForms: true,
      retainContextWhenHidden: true,
      // localResourceRoots intentionally empty: we don't serve local assets.
      localResourceRoots: [],
    },
  );
  panel.iconPath = new vscode.ThemeIcon('globe');
  panel.webview.html = getWebviewHtml(panel.webview, initialUrl);

  panel.webview.onDidReceiveMessage(
    async msg => {
      if (msg?.type === 'urlChanged' && typeof msg.url === 'string') {
        await context.globalState.update(STATE_LAST_URL, msg.url);
      } else if (msg?.type === 'log') {
        // Surface webview-side logs to a VS Code output channel for debugging.
        output().appendLine(`[webview] ${msg.message}`);
      } else if (msg?.type === 'openExternal' && typeof msg.url === 'string') {
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    if (currentPanel === panel) currentPanel = undefined;
  }, null, context.subscriptions);

  currentPanel = panel;
}

let _output: vscode.OutputChannel | undefined;
function output(): vscode.OutputChannel {
  if (!_output) _output = vscode.window.createOutputChannel('Web Chat Webview');
  return _output;
}
