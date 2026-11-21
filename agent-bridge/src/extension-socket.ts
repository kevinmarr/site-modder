import { WebSocketServer, WebSocket } from "ws";
import { EXTENSION_ID } from "./config.js";

/** Messages the extension sends to Agent Bridge. */
export type FromExtension =
  | { type: "hello"; extensionVersion?: string; tabs?: number[] }
  | { type: "open_chat"; tabId: number }
  | { type: "close_chat"; tabId: number }
  | { type: "prompt"; tabId: number; text: string; images?: PromptImage[]; elements?: PickedElement[]; page?: PageInfo }
  | { type: "cancel"; tabId: number }
  | { type: "new_session"; tabId: number }
  | { type: "permission_response"; id: string; optionId: string | null }
  | { type: "tool_result"; id: string; result?: unknown; error?: string; warning?: string }
  | { type: "set_model"; tabId: number; value: string }
  | { type: "set_effort"; tabId: number; value: string }
  | { type: "agent_select"; tabId: number; id: string }
  | { type: "agent_install"; id: string }
  | { type: "agent_remove"; id: string }
  | { type: "options_open" }
  | { type: "options_close" }
  | { type: "agents_refresh" }
  | { type: "sync_mods" }
  | { type: "mod_set_enabled"; id: string; enabled: boolean }
  | { type: "mod_delete"; id: string }
  | { type: "mod_reveal"; id: string }
  | { type: "mod_export"; id: string }
  | { type: "mod_import"; requestId: string; fileName: string; content: string }
  | { type: "history_list"; tabId: number }
  | { type: "history_restore"; tabId: number; sessionId: string }
  | { type: "auth_start"; agentId: string; methodId: string }
  | { type: "auth_input"; agentId: string; text: string }
  | { type: "auth_cancel"; agentId: string }
  | { type: "auth_recheck"; agentId: string };

export type PageInfo = { tabId?: number; url?: string; title?: string };
/** An image attached to a message: base64 data for the agent, and a small thumbnail (a data URL) for the chat. */
export type PromptImage = { mimeType: string; data: string; thumb?: string };
/** An element the user picked on the page to point the agent at. */
export type PickedElement = { selector: string; label: string; html?: string; text?: string };

type CallOptions = { timeoutMs?: number; skipBarrier?: boolean };

type Pending = {
  resolve: (v: { result: unknown; warning?: string }) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
};

/**
 * WebSocket to the extension's service worker. Only one extension
 * connection is active at a time; a new one replaces the old.
 */
export class ExtensionSocket {
  private wss: WebSocketServer;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private listeners: Array<(msg: FromExtension) => void> = [];
  private connectListeners: Array<() => void> = [];

  constructor(port: number) {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port,
      // Browsers always send Origin; web pages can't forge a chrome-extension:// one.
      verifyClient: ({ origin }: { origin?: string }) =>
        typeof origin === "string" &&
        (EXTENSION_ID
          ? origin === `chrome-extension://${EXTENSION_ID}`
          : origin.startsWith("chrome-extension://")),
    });

    this.wss.on("connection", (ws, req) => {
      console.log(`[extension] connected (${req.headers.origin})`);
      this.socket?.close(1000, "replaced");
      this.socket = ws;
      ws.on("message", (data) => {
        let msg: FromExtension;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        this.handle(msg);
      });
      ws.on("close", () => {
        if (this.socket !== ws) return;
        console.log("[extension] disconnected");
        this.socket = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Extension disconnected"));
          this.pending.delete(id);
        }
      });
      for (const l of this.connectListeners) l();
    });

    // MV3 service workers stay alive while WebSocket traffic flows (<30s gaps).
    setInterval(() => this.send({ type: "ping" }), 20_000).unref();
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(msg: Record<string, unknown>) {
    if (this.connected) this.socket!.send(JSON.stringify(msg));
  }

  private barrier: Promise<unknown> = Promise.resolve();

  /**
   * Hold browser calls until `work` settles. Used while mods are being applied
   * (and tabs reloaded) so the agent never inspects a stale page.
   */
  holdCallsUntil(work: Promise<unknown>) {
    const prev = this.barrier;
    this.barrier = Promise.allSettled([prev, work]);
  }

  /** Ask the extension to do something in the browser and await the result. */
  async call<T = unknown>(method: string, params: unknown = {}, options: CallOptions = {}): Promise<T> {
    return (await this.callWithWarning<T>(method, params, options)).result;
  }

  /** Like call(), plus any warning the extension attached (e.g. the tab navigated). */
  async callWithWarning<T = unknown>(
    method: string,
    params: unknown = {},
    { timeoutMs = 30_000, skipBarrier = false }: CallOptions = {},
  ): Promise<{ result: T; warning?: string }> {
    if (!skipBarrier) await this.barrier;
    if (!this.connected) throw new Error("Extension is not connected");
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      // Infinity = wait as long as it takes (e.g. for the user to switch tabs).
      // The call still fails if the extension disconnects.
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Browser call ${method} timed out`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve: resolve as (v: { result: unknown; warning?: string }) => void, reject, timer });
      this.send({ type: "tool_call", id, method, params });
    });
  }

  on(listener: (msg: FromExtension) => void) {
    this.listeners.push(listener);
  }

  onConnect(listener: () => void) {
    this.connectListeners.push(listener);
  }

  private handle(msg: FromExtension) {
    if (msg.type === "tool_result") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve({ result: msg.result, warning: msg.warning });
      return;
    }
    for (const l of this.listeners) l(msg);
  }
}
