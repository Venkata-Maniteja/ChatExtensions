import * as vscode from 'vscode';
import { chromium, Browser, Page } from 'playwright-core';
import { SELECTORS, SelectorSet } from './selectors';

export interface CdpDriverConfig {
  cdpEndpoint: string;
  targetUrl: string;
  timeoutMs: number;
  newChatPerRequest: boolean;
}

export type ConfigReader = () => CdpDriverConfig;

interface PageDriveArgs {
  promptText: string;
  requestId: string;
  selectors: SelectorSet;
  newChatPerRequest: boolean;
  bindingName: string;
}

const DELTA_BINDING = '__m365cdpDelta';

export class CdpDriver {
  private browser?: Browser;
  private readonly exposed = new WeakSet<Page>();
  private readonly onStatus = new vscode.EventEmitter<boolean>();
  readonly onStatusChange = this.onStatus.event;

  constructor(
    private readonly readConfig: ConfigReader,
    private readonly output: vscode.OutputChannel,
  ) {}

  isConnected(): boolean {
    return !!this.browser && this.browser.isConnected();
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const page = await this.findOrOpenTargetPage();
      return { ok: true, message: `Connected. Driving ${page.url()}` };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }

  async sendPrompt(
    requestId: string,
    text: string,
    onDelta: (snapshot: string) => void,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const cfg = this.readConfig();
    const page = await this.findOrOpenTargetPage();

    await this.ensureDeltaBinding(page, onDelta);

    let cancelReject: ((err: Error) => void) | undefined;
    const cancelPromise = new Promise<never>((_, reject) => {
      cancelReject = reject;
    });
    const cancelSub = token.onCancellationRequested(async () => {
      cancelReject?.(new Error('Cancelled by user.'));
      try {
        await page.evaluate((sel: SelectorSet) => {
          for (const s of sel.stopGenerating) {
            const b = document.querySelector(s) as HTMLButtonElement | null;
            if (b) { b.click(); break; }
          }
        }, SELECTORS);
      } catch { /* page may be gone */ }
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Request timed out.')), cfg.timeoutMs);
    });

    try {
      const drivePromise = page.evaluate(drivePageScript, {
        promptText: text,
        requestId,
        selectors: SELECTORS,
        newChatPerRequest: cfg.newChatPerRequest,
        bindingName: DELTA_BINDING,
      } satisfies PageDriveArgs);

      return await Promise.race([drivePromise, cancelPromise, timeoutPromise]);
    } finally {
      cancelSub.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = undefined;
      this.onStatus.fire(false);
    }
    this.onStatus.dispose();
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    const cfg = this.readConfig();
    this.output.appendLine(`[cdp] connecting to ${cfg.cdpEndpoint}`);
    const browser = await chromium.connectOverCDP(cfg.cdpEndpoint);
    browser.on('disconnected', () => {
      this.output.appendLine('[cdp] browser disconnected');
      if (this.browser === browser) this.browser = undefined;
      this.onStatus.fire(false);
    });
    this.browser = browser;
    this.onStatus.fire(true);
    return browser;
  }

  private async findOrOpenTargetPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const cfg = this.readConfig();
    const wantHost = new URL(cfg.targetUrl).host.toLowerCase();

    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        let host = '';
        try { host = new URL(p.url()).host.toLowerCase(); } catch { /* skip */ }
        if (host && host === wantHost) return p;
      }
    }

    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const p = await ctx.newPage();
    this.output.appendLine(`[cdp] opening ${cfg.targetUrl} in a new tab`);
    await p.goto(cfg.targetUrl, { waitUntil: 'domcontentloaded' });
    return p;
  }

  private async ensureDeltaBinding(
    page: Page,
    onDelta: (snapshot: string) => void,
  ): Promise<void> {
    if (!this.exposed.has(page)) {
      await page.exposeBinding(
        DELTA_BINDING,
        (_src, _id: string, snapshot: string) => {
          this.currentOnDelta?.(snapshot);
        },
      );
      this.exposed.add(page);
      page.on('close', () => this.exposed.delete(page));
    }
    this.currentOnDelta = onDelta;
  }

  private currentOnDelta?: (snapshot: string) => void;
}

// Runs inside the page. Receives args via Playwright serialization. Drives the
// composer, observes the latest assistant bubble, calls window[bindingName]
// with the full text snapshot on every mutation, and resolves with the final
// text once generation completes.
async function drivePageScript(args: PageDriveArgs): Promise<string> {
  const { promptText, requestId, selectors, newChatPerRequest, bindingName } = args;

  const pick = (list: string[]): Element | null => {
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const pickAll = (list: string[]): Element[] => {
    for (const sel of list) {
      const els = document.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    }
    return [];
  };
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const isGenerating = () => !!pick(selectors.stopGenerating);

  if (newChatPerRequest) {
    const nc = pick(selectors.newChat) as HTMLButtonElement | null;
    if (nc) { nc.click(); await sleep(250); }
  }

  const preCount = pickAll(selectors.assistantBubble).length;

  // --- type the prompt ---
  const inputEl = pick(selectors.input) as HTMLElement | null;
  if (!inputEl) throw new Error('Composer not found. Update selectors.input.');
  inputEl.focus();
  if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
    const proto = inputEl.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(inputEl, promptText);
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    inputEl.textContent = promptText;
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  // --- click send (retry briefly while it's disabled) ---
  let sent = false;
  for (let i = 0; i < 20; i++) {
    const btn = pick(selectors.sendButton) as HTMLButtonElement | null;
    if (btn && !btn.disabled) { btn.click(); sent = true; break; }
    await sleep(50);
  }
  if (!sent) {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true,
    }));
  }

  // --- wait for new assistant bubble (≤ 15s) ---
  const waitStart = Date.now();
  let bubble: Element | null = null;
  while (Date.now() - waitStart < 15000) {
    const list = pickAll(selectors.assistantBubble);
    if (list.length > preCount) { bubble = list[list.length - 1]; break; }
    const last = list[list.length - 1];
    if (last && isGenerating()) { bubble = last; break; }
    await sleep(100);
  }
  if (!bubble) throw new Error('Timed out waiting for assistant bubble. Update selectors.assistantBubble.');

  // --- stream until done ---
  return await new Promise<string>((resolve, reject) => {
    let last = '';
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const STALL_MS = 20_000;

    const emit = (window as unknown as Record<string, (id: string, snap: string) => void>)[bindingName];

    const sendDelta = () => {
      const snap = ((bubble as HTMLElement).innerText || '').trim();
      if (snap && snap !== last) {
        last = snap;
        try { emit?.(requestId, snap); } catch { /* ignore */ }
        resetStall();
      }
    };
    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!isGenerating()) finish();
      }, STALL_MS);
    };
    const finish = () => {
      cleanup();
      resolve(last);
    };
    const fail = (msg: string) => {
      cleanup();
      reject(new Error(msg));
    };
    const cleanup = () => {
      if (stallTimer) clearTimeout(stallTimer);
      clearInterval(doneTimer);
      observer.disconnect();
    };

    const observer = new MutationObserver(() => sendDelta());
    observer.observe(bubble!, { characterData: true, childList: true, subtree: true });

    let wasGen = isGenerating();
    const doneTimer = setInterval(() => {
      const g = isGenerating();
      if (wasGen && !g) {
        sendDelta();
        finish();
      }
      wasGen = g;
      if (!bubble || !document.contains(bubble)) fail('Assistant bubble was removed from DOM.');
    }, 400);

    sendDelta();
    resetStall();
  });
}
