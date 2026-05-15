import * as vscode from 'vscode';
import { CdpDriver } from './cdpDriver';
import { renderWebviewHtml } from './webview';

// Single-instance webview chat panel. Opens via the
// `m365CdpBridge.openChat` command. The webview owns the chat UI and history;
// this class only routes messages between the webview and the CDP driver.
export class ChatPanel {
  private static current: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly inflight = new Map<string, vscode.CancellationTokenSource>();

  static show(context: vscode.ExtensionContext, driver: CdpDriver): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'm365CdpBridge.chat',
      'M365 Copilot (CDP)',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    ChatPanel.current = new ChatPanel(panel, driver, context);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly driver: CdpDriver,
    _context: vscode.ExtensionContext,
  ) {
    this.panel = panel;
    this.panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
      this.driver.onStatusChange(connected => this.postStatus(connected)),
    );

    this.postStatus(this.driver.isConnected());
  }

  private postStatus(connected: boolean): void {
    this.panel.webview.postMessage({
      type: 'status',
      connected,
      text: connected ? 'browser connected' : 'no browser — launch Chrome with --remote-debugging-port=9222',
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ready':
        this.postStatus(this.driver.isConnected());
        return;
      case 'prompt':
        await this.handlePrompt(msg.id, msg.text);
        return;
      case 'cancel':
        this.inflight.get(msg.id)?.cancel();
        return;
    }
  }

  private async handlePrompt(id: string, text: string): Promise<void> {
    if (!id || typeof text !== 'string') return;
    const cts = new vscode.CancellationTokenSource();
    this.inflight.set(id, cts);

    const onDelta = (snapshot: string) => {
      this.panel.webview.postMessage({ type: 'delta', id, snapshot });
    };

    try {
      const final = await this.driver.sendPrompt(id, text, onDelta, cts.token);
      this.panel.webview.postMessage({ type: 'done', id, text: final });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.panel.webview.postMessage({ type: 'error', id, message });
    } finally {
      cts.dispose();
      this.inflight.delete(id);
    }
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    for (const cts of this.inflight.values()) cts.cancel();
    this.inflight.clear();
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.disposables.length = 0;
  }
}
