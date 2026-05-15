import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { CdpDriver } from './cdpDriver';

/**
 * Registers the `@m365cdp` chat participant. Same delta-diff streaming logic
 * as the WS-bridge variant: the driver hands us FULL snapshots of the
 * assistant bubble; we append only the new tail to the ChatResponseStream.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  driver: CdpDriver,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token,
  ) => {
    const id = randomUUID();
    stream.progress('Driving M365 Copilot over CDP…');

    let streamed = '';
    const onDelta = (snapshot: string) => {
      if (!snapshot.startsWith(streamed)) {
        stream.markdown('\n');
        streamed = '';
      }
      const tail = snapshot.slice(streamed.length);
      if (tail) {
        stream.markdown(tail);
        streamed = snapshot;
      }
    };

    try {
      const final = await driver.sendPrompt(id, request.prompt, onDelta, token);
      if (final && final.length > streamed.length) {
        stream.markdown(final.slice(streamed.length));
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
        stream.markdown(
          '\n\n⚠️  **Could not reach Chrome.** Launch Chrome with ' +
            '`--remote-debugging-port=9222 --user-data-dir=<some path>` ' +
            'and open `https://m365.cloud.microsoft/chat` in it. ' +
            'See [cdp-extension/README.md](command:vscode.open).',
        );
      } else {
        stream.markdown(`\n\n_Error: ${msg}_`);
      }
    }
  };

  const participant = vscode.chat.createChatParticipant(
    'm365cdpBridge.copilot',
    handler,
  );
  participant.iconPath = new vscode.ThemeIcon('comment-discussion');

  context.subscriptions.push(participant);
  return participant;
}
