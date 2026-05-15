import * as vscode from 'vscode';
import { BridgeServer } from './bridgeServer';
import { registerChatParticipant } from './chatParticipant';

let bridge: BridgeServer | undefined;
let statusBar: vscode.StatusBarItem | undefined;

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('m365Bridge');
  return {
    port: cfg.get<number>('port', 39847),
    timeoutMs: cfg.get<number>('requestTimeoutMs', 120_000),
    token: cfg.get<string>('sharedToken', ''),
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('M365 Copilot Bridge');
  context.subscriptions.push(output);

  bridge = new BridgeServer(output, readConfig);

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = 'm365Bridge.showStatus';
  context.subscriptions.push(statusBar);
  renderStatus(false);
  statusBar.show();

  context.subscriptions.push(
    bridge.onStatusChange(connected => renderStatus(connected)),
  );

  try {
    await bridge.start();
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `M365 Bridge: failed to start WebSocket server: ${err?.message ?? err}`,
    );
  }

  registerChatParticipant(context, bridge);

  context.subscriptions.push(
    vscode.commands.registerCommand('m365Bridge.showStatus', () => {
      const { port } = readConfig();
      const connected = bridge?.isBrowserConnected() ? 'connected' : 'NOT connected';
      vscode.window.showInformationMessage(
        `M365 Bridge — WS server on 127.0.0.1:${port}, browser ${connected}.`,
      );
      output.show(true);
    }),
    vscode.commands.registerCommand('m365Bridge.restartServer', async () => {
      if (!bridge) return;
      await bridge.stop();
      try {
        await bridge.start();
        vscode.window.showInformationMessage('M365 Bridge: server restarted.');
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `M365 Bridge: restart failed: ${err?.message ?? err}`,
        );
      }
    }),
    // Restart server when port/token changes.
    vscode.workspace.onDidChangeConfiguration(async ev => {
      if (
        ev.affectsConfiguration('m365Bridge.port') ||
        ev.affectsConfiguration('m365Bridge.sharedToken')
      ) {
        if (!bridge) return;
        await bridge.stop();
        try { await bridge.start(); } catch { /* surfaced in output channel */ }
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await bridge?.stop();
  bridge = undefined;
  statusBar?.dispose();
  statusBar = undefined;
}

function renderStatus(connected: boolean): void {
  if (!statusBar) return;
  statusBar.text = connected
    ? '$(check) M365 Bridge'
    : '$(circle-slash) M365 Bridge';
  statusBar.tooltip = connected
    ? 'Browser bridge connected. Use @m365 in Chat.'
    : 'No browser connected. Open copilot.cloud.microsoft in the browser with the bridge extension.';
}
