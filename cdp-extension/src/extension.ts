import * as vscode from 'vscode';
import { CdpDriver, CdpDriverConfig } from './cdpDriver';
import { registerChatParticipant } from './chatParticipant';
import { ChatPanel } from './chatPanel';

let driver: CdpDriver | undefined;
let statusBar: vscode.StatusBarItem | undefined;

function readConfig(): CdpDriverConfig {
  const cfg = vscode.workspace.getConfiguration('m365CdpBridge');
  return {
    cdpEndpoint: cfg.get<string>('cdpEndpoint', 'http://127.0.0.1:9222'),
    targetUrl: cfg.get<string>('targetUrl', 'https://m365.cloud.microsoft/chat'),
    timeoutMs: cfg.get<number>('requestTimeoutMs', 120_000),
    newChatPerRequest: cfg.get<boolean>('newChatPerRequest', false),
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('M365 Copilot CDP Bridge');
  context.subscriptions.push(output);

  driver = new CdpDriver(readConfig, output);

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = 'm365CdpBridge.openChat';
  context.subscriptions.push(statusBar);
  renderStatus(false);
  statusBar.show();

  context.subscriptions.push(
    driver.onStatusChange(connected => renderStatus(connected)),
  );

  try {
    registerChatParticipant(context, driver);
  } catch (err: any) {
    output.appendLine(`[cdp] chat participant unavailable: ${err?.message ?? err}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('m365CdpBridge.openChat', () => {
      if (!driver) return;
      ChatPanel.show(context, driver);
    }),
    vscode.commands.registerCommand('m365CdpBridge.testConnection', async () => {
      if (!driver) return;
      const res = await driver.testConnection();
      if (res.ok) vscode.window.showInformationMessage(`M365 CDP Bridge: ${res.message}`);
      else vscode.window.showErrorMessage(`M365 CDP Bridge: ${res.message}`);
      output.show(true);
    }),
    vscode.commands.registerCommand('m365CdpBridge.showStatus', () => {
      const { cdpEndpoint, targetUrl } = readConfig();
      const connected = driver?.isConnected() ? 'connected' : 'NOT connected';
      vscode.window.showInformationMessage(
        `M365 CDP Bridge — ${connected} to ${cdpEndpoint}, target ${targetUrl}.`,
      );
      output.show(true);
    }),
  );
}

export async function deactivate(): Promise<void> {
  await driver?.dispose();
  driver = undefined;
  statusBar?.dispose();
  statusBar = undefined;
}

function renderStatus(connected: boolean): void {
  if (!statusBar) return;
  statusBar.text = connected
    ? '$(check) M365 CDP'
    : '$(circle-slash) M365 CDP';
  statusBar.tooltip = connected
    ? 'CDP bridge connected. Click to open the chat panel.'
    : 'No browser connected. Click to open chat — launch Chrome with --remote-debugging-port=9222 first.';
}
