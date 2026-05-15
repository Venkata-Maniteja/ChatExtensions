import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { BridgeServer } from './bridgeServer';

/**
 * Registers the `@m365` chat participant. Each request:
 *   1. Generates a UUID.
 *   2. Asks the bridge to send the prompt to the browser.
 *   3. Receives back FULL snapshots of the assistant message on every DOM
 *      mutation, diffs against what's already been streamed, and appends
 *      only the new tail to the ChatResponseStream.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  bridge: BridgeServer,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token,
  ) => {
    if (!bridge.isBrowserConnected()) {
      stream.markdown(
        '⚠️  **No browser connected.** Open ' +
          '[copilot.cloud.microsoft](https://copilot.cloud.microsoft) in the ' +
          'browser where the bridge Chrome extension is installed, then try ' +
          'again.\n',
      );
      return;
    }

    const id = randomUUID();
    stream.progress('Sending prompt to M365 Copilot…');

    let streamed = '';
    const onDelta = (snapshot: string) => {
      if (!snapshot.startsWith(streamed)) {
        // Snapshot diverged (e.g., Copilot rewrote part of its reply mid-
        // generation). Reset by emitting a soft separator and the new tail.
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
      await bridge.sendPrompt(id, request.prompt, onDelta, token);
    } catch (err: any) {
      stream.markdown(`\n\n_Error: ${err?.message ?? String(err)}_`);
    }
  };

  const participant = vscode.chat.createChatParticipant(
    'm365bridge.copilot',
    handler,
  );
  participant.iconPath = new vscode.ThemeIcon('comment-discussion');

  context.subscriptions.push(participant);
  return participant;
}
