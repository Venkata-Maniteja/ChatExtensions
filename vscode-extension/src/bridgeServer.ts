import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import * as vscode from 'vscode';
import {
  ClientToServer,
  PromptFrame,
  CancelFrame,
} from './protocol';

export type PendingRequest = {
  id: string;
  // Best-effort accumulating buffer; the source of truth is whatever the
  // browser sends in response.delta.text (full snapshot each time).
  lastSnapshot: string;
  resolve: (finalText: string) => void;
  reject: (err: Error) => void;
  // Called for every delta with the FULL snapshot. The chat participant
  // diffs against its previous emission to compute what to append.
  onDelta: (snapshot: string) => void;
  timer: NodeJS.Timeout;
};

/**
 * BridgeServer hosts a WebSocket server on 127.0.0.1 and brokers prompts
 * between the VS Code chat participant and the Chrome extension.
 *
 * It accepts exactly one "browser" client at a time. If a new browser
 * connects, the previous one is dropped — this keeps routing trivial and
 * avoids fan-out ambiguity.
 */
export class BridgeServer {
  private wss?: WebSocketServer;
  private browserClient?: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events = new EventEmitter();

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly getConfig: () => {
      port: number;
      timeoutMs: number;
      token: string;
    },
  ) {}

  /** Resolves when the server is listening. Throws on bind failure. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { port } = this.getConfig();
      const wss = new WebSocketServer({ host: '127.0.0.1', port });

      wss.on('listening', () => {
        this.output.appendLine(
          `[bridge] listening on ws://127.0.0.1:${port}`,
        );
        resolve();
      });
      wss.on('error', err => {
        this.output.appendLine(`[bridge] server error: ${err.message}`);
        reject(err);
      });
      wss.on('connection', (ws, req) => this.onConnection(ws, req.url ?? ''));

      this.wss = wss;
    });
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = undefined;
    this.browserClient = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Bridge server stopping'));
    }
    this.pending.clear();
    if (!wss) return;
    await new Promise<void>(res => wss.close(() => res()));
  }

  isBrowserConnected(): boolean {
    return !!this.browserClient && this.browserClient.readyState === WebSocket.OPEN;
  }

  /** Subscribe to connection-state changes (for status bar UI, etc.) */
  onStatusChange(fn: (connected: boolean) => void): vscode.Disposable {
    this.events.on('status', fn);
    return { dispose: () => this.events.off('status', fn) };
  }

  /**
   * Send a prompt and stream snapshots back via `onDelta`. The returned
   * promise resolves with the final text on `response.done` or rejects on
   * `response.error` / timeout / cancellation.
   */
  sendPrompt(
    id: string,
    text: string,
    onDelta: (snapshot: string) => void,
    cancellation: vscode.CancellationToken,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.isBrowserConnected()) {
        reject(
          new Error(
            'No M365 Copilot browser tab is connected. Open https://copilot.cloud.microsoft and make sure the Chrome bridge extension is installed.',
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timed out waiting for Copilot response.'));
      }, this.getConfig().timeoutMs);

      const req: PendingRequest = {
        id,
        lastSnapshot: '',
        resolve: finalText => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(finalText);
        },
        reject: err => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        },
        onDelta,
        timer,
      };
      this.pending.set(id, req);

      cancellation.onCancellationRequested(() => {
        this.sendToBrowser({ type: 'cancel', id });
        req.reject(new Error('Cancelled by user'));
      });

      const frame: PromptFrame = { type: 'prompt', id, text };
      this.sendToBrowser(frame);
    });
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private onConnection(ws: WebSocket, urlPath: string): void {
    const { token: expected } = this.getConfig();
    if (expected) {
      // Token may be passed as `?token=...` in the WS URL.
      const got = new URLSearchParams(urlPath.split('?')[1] ?? '').get('token');
      if (got !== expected) {
        this.output.appendLine('[bridge] rejected connection: bad token');
        ws.close(4401, 'bad token');
        return;
      }
    }

    // Drop any previous browser to keep a single-source-of-truth client.
    if (this.browserClient && this.browserClient !== ws) {
      try { this.browserClient.close(4000, 'superseded'); } catch { /* ignore */ }
    }
    this.browserClient = ws;
    this.output.appendLine('[bridge] browser connected');
    this.events.emit('status', true);

    ws.on('message', raw => {
      let msg: ClientToServer;
      try {
        msg = JSON.parse(raw.toString()) as ClientToServer;
      } catch {
        this.output.appendLine(`[bridge] dropped non-JSON frame`);
        return;
      }
      this.handleFrame(msg);
    });

    ws.on('close', () => {
      if (this.browserClient === ws) {
        this.browserClient = undefined;
        this.output.appendLine('[bridge] browser disconnected');
        this.events.emit('status', false);
      }
    });
    ws.on('error', err => {
      this.output.appendLine(`[bridge] socket error: ${err.message}`);
    });
  }

  private handleFrame(msg: ClientToServer): void {
    switch (msg.type) {
      case 'hello':
        // already accepted on connection; nothing more to do.
        return;
      case 'response.delta': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        p.lastSnapshot = msg.text;
        try { p.onDelta(msg.text); } catch (e: any) {
          this.output.appendLine(`[bridge] onDelta threw: ${e?.message}`);
        }
        return;
      }
      case 'response.done': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        // Make sure subscribers see the final snapshot before resolution.
        if (msg.text && msg.text !== p.lastSnapshot) {
          try { p.onDelta(msg.text); } catch { /* ignore */ }
        }
        p.resolve(msg.text ?? p.lastSnapshot);
        return;
      }
      case 'response.error': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        p.reject(new Error(msg.message || 'Copilot returned an error'));
        return;
      }
    }
  }

  private sendToBrowser(frame: PromptFrame | CancelFrame): void {
    const ws = this.browserClient;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }
}
