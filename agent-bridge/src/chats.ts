import fs from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { AgentProcess } from "./agent-process.js";
import type { AgentManager } from "./agents.js";
import { AUTH_REQUIRED } from "./auth.js";
import type { ToolSocket } from "./tool-socket.js";
import { HOME, MODS_DIR } from "./config.js";
import type { ExtensionSocket, FromExtension, PageInfo, PickedElement, PromptImage } from "./extension-socket.js";
import { modApplies } from "./match.js";
import { isModFile } from "./modfile.js";
import { loadMods, type Mod } from "./mods.js";

/**
 * One chat per browser tab. Each chat has its own agent (tabs can use
 * different agents) and its own ACP session; tabs using the same agent share
 * one agent process. Chats are saved to ~/.eyepatch/sessions so they can
 * be restored later.
 */

const SESSIONS_DIR = path.join(HOME, "sessions");
const MAX_EVENTS = 2000;
/** How long after an agent edits a mod its tab counts as the one that changed it. */
const EDIT_ATTRIBUTION_MS = 120_000;

/**
 * Browser tools that run without asking (read-only, plus reloading the tab),
 * as agents title them when asking permission:
 * "mcp__eyepatch__get_tab" (Claude), "eyepatch.get_tab", …
 */
const UNPROMPTED_BROWSER_TOOL =
  /eyepatch[^a-z0-9]{1,3}(get_tab|get_page_content|query_selector_all|screenshot|get_console_logs|reload_tab)($|[^a-z0-9_])/i;

/** Browser tools the user approves each use of, whatever the agent's own approval settings. */
const GUARDED_TOOLS: Record<string, string> = { run_js: "Run JavaScript in the page" };
const guardedToolIn = (title: string) =>
  Object.keys(GUARDED_TOOLS).find((t) => new RegExp(`eyepatch[^a-z0-9]{1,3}${t}($|[^a-z0-9_])`, "i").test(title));
/** How long a permission the agent asked for covers the tool call that follows it. */
const APPROVAL_WINDOW_MS = 60_000;

/** Something shown in a tab's chat, replayed when its side panel opens. */
type ChatEvent = Record<string, unknown> & { type: string };

type Chat = {
  tabId: number;
  agentId: string | null;
  sessionId?: string;
  sessionStarting?: Promise<string>;
  busy: boolean;
  configOptions: acp.SessionConfigOption[];
  /** This conversation's route to the browser tools. */
  browserTools?: { dispose: () => void };
  /** Guarded tools the user just approved (tool -> when), or always allows in this chat. */
  approvals: Map<string, number>;
  alwaysAllowed: Set<string>;
  events: ChatEvent[];
  /** Mods this chat's agent edited, and when (for deciding which tabs to reload). */
  edits: Map<string, number>;
  createdAt: number;
  url?: string;
  /** Bumped when the tab starts a new conversation, so a turn from the old one ends quietly. */
  conversation: number;
  /** How many events were last saved, so an unchanged chat isn't saved again. */
  saved: number;
  /** A saved chat to reopen when this chat's session starts. */
  reopen?: { sessionId: string; agentId: string | null };
  /** The saved chat this one was restored from; replaced if it continues under a new session. */
  restoredFrom?: string;
};

/** A saved chat, as listed in the side panel. */
type HistoryItem = { sessionId: string; agentId: string | null; agent: string | null; title: string; url: string | null; updatedAt: string };

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Context prepended to each user message: the tab, and the mods that apply
 * to it (matched the same way Chrome does), so the agent knows what's already
 * running without searching.
 */
async function pageContext(page: PageInfo) {
  if (!page.url) return "";
  const lines = [`<active-tab url="${attr(page.url)}" title="${attr(page.title ?? "")}" />`];
  let mods: Mod[] = [];
  try {
    mods = (await loadMods()).filter((m) => (m.matches.length || m.filter) && modApplies(m, page.url!));
  } catch (e) {
    console.error("[chats] could not load mods for context:", e);
  }
  if (mods.length) {
    lines.push("<mods-on-this-page>");
    for (const m of mods) {
      const flags = [!m.enabled && "disabled", m.error && `error: ${m.error}`, ...(m.warnings ?? [])].filter(Boolean);
      lines.push(`  ${m.id} — ${m.name}${m.description ? `: ${m.description}` : ""}${flags.length ? ` [${flags.join("; ")}]` : ""}`);
    }
    lines.push("</mods-on-this-page>");
  } else {
    lines.push("<mods-on-this-page>none</mods-on-this-page>");
  }
  return lines.join("\n") + "\n\n";
}

/** Elements the user picked on the page, so the agent knows what "this" refers to. */
function pickedContext(elements: PickedElement[]) {
  if (!elements.length) return "";
  const parts = elements.map(
    (e) =>
      `<selected-element selector="${attr(e.selector)}">\n${e.html ?? ""}${e.text ? `\n<text>${e.text}</text>` : ""}\n</selected-element>`,
  );
  return `The user picked ${elements.length === 1 ? "this element" : "these elements"} on the page:\n${parts.join("\n")}\n\n`;
}

/** The mod a file path is, if it's a mod file in the mods dir. */
function modIdOf(file: unknown): string | null {
  if (typeof file !== "string") return null;
  const rel = path.relative(MODS_DIR, path.resolve(MODS_DIR, file));
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  return isModFile(rel) ? rel : null;
}

/** Merge streamed chunks so saved history stays small. */
function compact(events: ChatEvent[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    const u = e.type === "session_update" ? (e.update as { sessionUpdate: string; content?: { type: string; text?: string } }) : null;
    const pu = prev?.type === "session_update" ? (prev.update as typeof u) : null;
    if (u && pu && u.sessionUpdate === pu!.sessionUpdate && /_chunk$/.test(u.sessionUpdate) && u.content?.type === "text" && pu!.content?.type === "text") {
      out[out.length - 1] = {
        ...prev,
        update: { ...pu, content: { ...pu!.content, text: (pu!.content.text ?? "") + (u.content.text ?? "") } },
      };
    } else {
      out.push(e);
    }
  }
  return out;
}

export class Chats {
  private chats = new Map<number, Chat>();
  private agents = new Map<string, AgentProcess>();
  private permissions = new Map<string, (optionId: string | null) => void>();
  private permissionSeq = 0;
  /** Saved chats' summaries by file, kept until the file changes. */
  private historyIndex = new Map<string, { mtimeMs: number; item: HistoryItem | null }>();
  /** The Options page is open: keep every installed agent running so it can show their sign-in status. */
  private optionsOpen = false;

  constructor(
    private readonly extension: ExtensionSocket,
    private readonly catalog: AgentManager,
    private readonly toolSocket: ToolSocket,
  ) {
    extension.on((msg) => this.onMessage(msg));
    extension.onConnect(() => {
      catalog.sendView();
      for (const agent of this.agents.values()) agent.auth.send();
    });
    // A newer copy of an agent was installed: switch to it once its chats are idle.
    catalog.onUpdated((id) => this.restartWhenIdle(id));
    void fs.mkdir(SESSIONS_DIR, { recursive: true });
  }

  /** Mod ids → the tabs whose agent just edited them. Empty if none did (e.g. a hand edit). */
  tabsThatEdited(modIds: string[]): number[] {
    const now = Date.now();
    const tabs = new Set<number>();
    for (const chat of this.chats.values()) {
      for (const id of modIds) {
        const t = chat.edits.get(id);
        if (t && now - t < EDIT_ATTRIBUTION_MS) tabs.add(chat.tabId);
      }
    }
    return [...tabs];
  }

  // ---------- messages from the extension ----------

  private onMessage(msg: FromExtension) {
    switch (msg.type) {
      case "hello":
        this.forgetClosedTabs(msg.tabs);
        this.catalog.sendView();
        for (const agent of this.agents.values()) agent.auth.send();
        break;
      case "open_chat":
        void this.open(msg.tabId);
        break;
      case "close_chat":
        void this.close(msg.tabId);
        break;
      case "prompt":
        void this.prompt(msg.tabId, msg.text, msg.page, msg.images, msg.elements);
        break;
      case "cancel":
        void this.cancel(msg.tabId);
        break;
      case "new_session":
        void this.newSession(msg.tabId);
        break;
      case "history_list":
        void this.listHistory().then((items) => this.extension.send({ type: "history", tabId: msg.tabId, items }));
        break;
      case "history_restore":
        void this.restore(msg.tabId, msg.sessionId);
        break;
      case "permission_response":
        this.permissions.get(msg.id)?.(msg.optionId);
        break;
      case "set_model":
        void this.setOption(msg.tabId, "model", msg.value);
        break;
      case "set_effort":
        void this.setOption(msg.tabId, "effort", msg.value);
        break;
      case "agent_select":
        void this.setAgent(msg.tabId, msg.id);
        break;
      case "agents_refresh":
        void this.catalog.refresh();
        break;
      case "agent_install":
        void this.install(msg.id);
        break;
      case "agent_remove":
        void this.remove(msg.id);
        break;
      case "options_open":
        this.optionsOpen = true;
        for (const id of this.catalog.installedIds()) this.process(id)?.auth.send();
        break;
      case "options_close":
        this.optionsOpen = false;
        this.stopUnusedAgents();
        break;
      case "auth_start":
        void this.process(msg.agentId)?.auth.start(msg.methodId);
        break;
      case "auth_input":
        this.agents.get(msg.agentId)?.auth.input(msg.text);
        break;
      case "auth_cancel":
        this.agents.get(msg.agentId)?.auth.cancel();
        break;
      case "auth_recheck": {
        // The user may have signed in outside Eyepatch; a fresh agent
        // process re-reads its credentials and reports status again.
        const agent = this.process(msg.agentId);
        if (agent && !this.busyOn(agent.id)) void agent.restart();
        break;
      }
    }
  }

  /** Install an agent from the Options page. It becomes the agent for new tabs. */
  private async install(id: string) {
    if (!(await this.catalog.choose(id))) return;
    this.adoptDefault();
    if (this.optionsOpen) this.process(id);
  }

  /** Uninstall an agent. Tabs using it end their chat and move to the default agent. */
  private async remove(id: string) {
    for (const chat of this.chatsOn(id)) {
      await this.cancel(chat.tabId);
      await this.endSession(chat);
      chat.agentId = null;
    }
    this.agents.get(id)?.stop();
    this.agents.delete(id);
    await this.catalog.remove(id);
    this.adoptDefault();
  }

  /** Tabs without an agent (none was installed, or theirs was removed) start using the default. */
  private adoptDefault() {
    const id = this.catalog.defaultId;
    for (const chat of this.chats.values()) {
      if (chat.agentId) continue;
      chat.agentId = id;
      this.extension.send({ type: "transcript", tabId: chat.tabId, events: chat.events });
      this.sendChat(chat);
      const agent = this.agentFor(chat);
      if (agent) {
        agent.auth.send();
        if (agent.ready) void this.ensureSession(chat).catch(() => {});
      }
    }
  }

  // ---------- chats ----------

  private chat(tabId: number): Chat {
    let chat = this.chats.get(tabId);
    if (!chat) {
      chat = {
        tabId,
        agentId: this.catalog.defaultId,
        busy: false,
        configOptions: [],
        events: [],
        edits: new Map(),
        createdAt: Date.now(),
        conversation: 0,
        saved: 0,
        approvals: new Map(),
        alwaysAllowed: new Set(),
      };
      this.chats.set(tabId, chat);
    }
    return chat;
  }

  private chatsOn(agentId: string) {
    return [...this.chats.values()].filter((c) => c.agentId === agentId);
  }

  private busyOn(agentId: string) {
    return this.chatsOn(agentId).some((c) => c.busy);
  }

  /** A side panel opened for this tab: send its state and history, and get its agent going. */
  private async open(tabId: number) {
    const chat = this.chat(tabId);
    // A tab opened before any agent was installed picks up the default once there is one.
    if (!chat.agentId && this.catalog.defaultId) chat.agentId = this.catalog.defaultId;
    this.extension.send({ type: "transcript", tabId, events: chat.events });
    this.sendChat(chat);
    const agent = this.agentFor(chat);
    if (agent) {
      agent.auth.send();
      // Start the conversation now so the agent's models show before the first message.
      if (agent.ready) void this.ensureSession(chat).catch(() => {});
    }
  }

  /** The tab closed: end its session but keep its history. */
  private async close(tabId: number) {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    await this.cancel(tabId);
    await this.endSession(chat);
    this.chats.delete(tabId);
    this.stopUnusedAgents();
  }

  /** After a browser restart, tab ids are new; drop chats for tabs that no longer exist. */
  private forgetClosedTabs(open: number[] | undefined) {
    if (!open) return;
    for (const tabId of [...this.chats.keys()]) if (!open.includes(tabId)) void this.close(tabId);
  }

  private async newSession(tabId: number) {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    await this.cancel(tabId);
    await this.endSession(chat);
    this.extension.send({ type: "transcript", tabId, events: [] });
    this.sendChat(chat);
    const agent = this.agentFor(chat);
    if (agent?.ready) void this.ensureSession(chat).catch(() => {});
  }

  /** Use another agent in this tab (installing it if needed). Starts a new conversation. */
  private async setAgent(tabId: number, agentId: string) {
    const chat = this.chat(tabId);
    if (!(await this.catalog.choose(agentId))) return;
    if (chat.agentId === agentId && chat.sessionId) return;
    await this.cancel(tabId); // like New chat, this interrupts a reply in progress
    await this.endSession(chat);
    chat.agentId = agentId;
    this.extension.send({ type: "transcript", tabId, events: [] });
    this.sendChat(chat);
    const agent = this.agentFor(chat)!;
    agent.auth.send();
    if (agent.ready) void this.ensureSession(chat).catch(() => {});
    this.stopUnusedAgents();
  }

  /** Save the chat's history and forget its session (the agent keeps its own copy). */
  private async endSession(chat: Chat) {
    await this.saveHistory(chat);
    if (chat.sessionId) this.agents.get(chat.agentId ?? "")?.removeSession(chat.sessionId);
    chat.browserTools?.dispose();
    chat.browserTools = undefined;
    chat.sessionId = undefined;
    chat.sessionStarting = undefined;
    chat.configOptions = [];
    chat.events = [];
    chat.edits.clear();
    chat.approvals.clear();
    chat.alwaysAllowed.clear();
    chat.createdAt = Date.now();
    chat.busy = false;
    chat.conversation++;
    chat.saved = 0;
    chat.reopen = undefined;
    chat.restoredFrom = undefined;
    chat.url = undefined;
  }

  private sendChat(chat: Chat) {
    const agent = chat.agentId ? this.agents.get(chat.agentId) : undefined;
    this.extension.send({
      type: "chat",
      tabId: chat.tabId,
      chat: {
        agentId: chat.agentId,
        agent: agent?.name ?? (chat.agentId ? this.catalog.nameOf(chat.agentId) : null),
        ready: Boolean(agent?.ready),
        images: Boolean(agent?.images),
        busy: chat.busy,
        sessionId: chat.sessionId ?? null,
        model: this.optionView(chat, "model"),
        effort: this.optionView(chat, "effort"),
      },
    });
  }

  /** Record something for the tab's chat and send it to the extension. */
  private emit(chat: Chat, event: ChatEvent) {
    event.at ??= Date.now(); // the side panel shows how long turns and tools took
    chat.events.push(event);
    if (chat.events.length > MAX_EVENTS) chat.events = chat.events.slice(-MAX_EVENTS);
    this.extension.send({ ...event, tabId: chat.tabId });
  }

  private error(chat: Chat, message: string) {
    this.emit(chat, { type: "error", message });
  }

  // ---------- agents ----------

  /** The chat's agent process, started if it isn't running. */
  private agentFor(chat: Chat): AgentProcess | undefined {
    return chat.agentId ? this.process(chat.agentId) : undefined;
  }

  /** An installed agent's process, started if it isn't running. */
  private process(id: string): AgentProcess | undefined {
    if (!this.catalog.isInstalled(id)) return undefined;
    let agent = this.agents.get(id);
    if (!agent) {
      agent = new AgentProcess(id, {
        agents: this.catalog,
        send: (msg) => this.extension.send(msg),
        onReady: (a) => {
          for (const c of this.chatsOn(a.id)) {
            this.sendChat(c);
            void this.ensureSession(c).catch(() => {});
          }
        },
        onReset: (a) => {
          for (const c of this.chatsOn(a.id)) {
            this.cancelPermissions(c);
            c.browserTools?.dispose();
            c.browserTools = undefined;
            c.sessionId = undefined;
            c.sessionStarting = undefined;
            c.busy = false;
            c.configOptions = [];
            this.sendChat(c);
          }
        },
      });
      this.agents.set(id, agent);
      agent.start().catch((e) => console.error(`[${id}] failed to start:`, e));
    }
    return agent;
  }

  /** Stop agent processes no tab uses anymore (unless the Options page is showing them). */
  private stopUnusedAgents() {
    for (const [id, agent] of this.agents) {
      if (!this.chatsOn(id).length && !(this.optionsOpen && this.catalog.isInstalled(id))) {
        agent.stop();
        this.agents.delete(id);
      }
    }
  }

  private pendingRestarts = new Set<string>();

  private restartWhenIdle(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent) return; // not running; the new copy is used next time it starts
    if (this.busyOn(agentId)) this.pendingRestarts.add(agentId);
    else void agent.restart();
  }

  // ---------- sessions ----------

  /** Create the chat's session once, even if several callers ask at the same time. */
  private ensureSession(chat: Chat): Promise<string> {
    if (chat.sessionId) return Promise.resolve(chat.sessionId);
    chat.sessionStarting ??= this.createSession(chat).finally(() => (chat.sessionStarting = undefined));
    return chat.sessionStarting;
  }

  private async createSession(chat: Chat): Promise<string> {
    const agent = this.agentFor(chat);
    const conn = agent?.conn;
    if (!agent?.ready || !conn) throw new Error("The agent is still starting. Try again in a moment.");
    const agentId = agent.id;

    // Browser tools for this tab only: a stdio MCP server the agent starts,
    // which connects back to Agent Bridge.
    const tools = this.toolSocket.register(async (method, args, options) => {
      if (GUARDED_TOOLS[method] && !(await this.approveTool(chat, method, args))) {
        throw new Error("The user declined this.");
      }
      return this.extension.callWithWarning(method, { ...(args as object), tabId: chat.tabId }, options);
    });

    let res: { sessionId: string; configOptions?: acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null } | undefined;
    const reopen = chat.reopen;
    chat.reopen = undefined;
    try {
      if (reopen) res = await this.reopenSession(chat, agent, reopen, tools.server);
      res ??= await conn.agent.request(acp.methods.agent.session.new, {
        cwd: MODS_DIR,
        mcpServers: [tools.server],
      });
    } catch (e) {
      tools.dispose();
      if ((e as { code?: number }).code === AUTH_REQUIRED) {
        agent.auth.markAuthRequired();
        chat.reopen ??= reopen; // try again once signed in
      }
      throw e;
    }
    if (agent.conn !== conn || chat.agentId !== agentId) {
      tools.dispose();
      throw new Error("The agent restarted");
    }
    chat.sessionId = res.sessionId;
    chat.browserTools = tools;
    chat.configOptions = res.configOptions ?? [];
    agent.addSession(res.sessionId, {
      onUpdate: (update) => this.onUpdate(chat, update),
      onPermission: (params, signal) => this.requestPermission(chat, params, signal),
    });

    // Mods live in their own directory and apply live, so don't prompt for
    // every file edit. Commands and other tools still ask in the side panel.
    const acceptEdits = res.modes?.availableModes.find((m) => m.id === "acceptEdits");
    if (acceptEdits) {
      await conn.agent.request(acp.methods.agent.session.setMode, { sessionId: res.sessionId, modeId: acceptEdits.id });
    }
    // Use the model and effort last picked for this agent (model first: the
    // effort levels on offer can depend on it).
    for (const kind of ["model", "effort"] as const) {
      const preferred = this.catalog.preferred(kind, agentId);
      const opt = this.selectOption(chat, kind);
      if (!opt || !preferred || preferred === opt.currentValue || !this.flatOptions(opt).some((o) => o.value === preferred)) continue;
      try {
        const set = await conn.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: res.sessionId,
          configId: opt.id,
          value: preferred,
        });
        chat.configOptions = set.configOptions;
      } catch (e) {
        console.warn(`[${agentId}] couldn't restore the ${kind}:`, (e as Error).message);
      }
    }
    this.sendChat(chat);
    return res.sessionId;
  }

  /**
   * Continue a saved chat in the agent's own session, if the agent can reopen
   * one. Otherwise (or if it fails) the chat goes on in a new session, and the
   * agent doesn't remember the earlier messages.
   */
  private async reopenSession(
    chat: Chat,
    agent: AgentProcess,
    saved: NonNullable<Chat["reopen"]>,
    server: acp.McpServer,
  ) {
    const startsOver = (why: string) => this.emit(chat, { type: "note", text: `${why} Your next message starts a new conversation with ${agent.name}.` });
    if (saved.agentId !== agent.id) {
      startsOver(`${this.catalog.nameOf(saved.agentId ?? "") || "That agent"} isn't installed.`);
      return undefined;
    }
    if (!agent.reopen) {
      startsOver(`${agent.name} can't continue earlier chats.`);
      return undefined;
    }
    const params = { sessionId: saved.sessionId, cwd: MODS_DIR, mcpServers: [server] };
    try {
      // session/load replays the conversation as updates; the session isn't
      // registered yet, so they're dropped (the chat already shows it).
      const r = await agent.conn!.agent.request(
        agent.reopen === "resume" ? acp.methods.agent.session.resume : acp.methods.agent.session.load,
        params,
      );
      return { ...(r ?? {}), sessionId: saved.sessionId };
    } catch (e) {
      if ((e as { code?: number }).code === AUTH_REQUIRED) throw e;
      console.warn(`[${agent.id}] couldn't reopen ${saved.sessionId}:`, (e as Error).message);
      startsOver(`${agent.name} couldn't continue this chat.`);
      return undefined;
    }
  }

  private onUpdate(chat: Chat, update: acp.SessionUpdate) {
    if (update.sessionUpdate === "config_option_update") {
      chat.configOptions = update.configOptions;
      this.sendChat(chat);
      return;
    }
    // Remember which mods this chat's agent edits, so only its tab reloads.
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const files = [
        ...(update.locations ?? []).map((l) => l.path),
        (update.rawInput as { file_path?: unknown } | null | undefined)?.file_path,
      ];
      for (const f of files) {
        const id = modIdOf(f);
        if (id) chat.edits.set(id, Date.now());
      }
    }
    this.emit(chat, { type: "session_update", update });
  }

  private async prompt(tabId: number, text: string, page?: PageInfo, images: PromptImage[] = [], elements: PickedElement[] = []) {
    const chat = this.chat(tabId);
    const agent = this.agentFor(chat);
    if (!agent) return this.error(chat, "Choose an agent first.");
    if (!agent.ready) return this.error(chat, "The agent is still starting. Try again in a moment.");
    if (chat.busy) return this.error(chat, "The agent is busy; stop it or wait for it to finish.");
    if (agent.auth.needsSignIn) return this.error(chat, `Authenticate ${agent.name} first.`);
    if (images.length && !agent.images) return this.error(chat, `${agent.name} can't read images.`);

    chat.busy = true;
    const conversation = chat.conversation;
    // The user started a new chat (or switched agents) mid-turn: that ended
    // this turn on purpose, so nothing about it belongs in the new chat.
    const replaced = () => chat.conversation !== conversation;
    chat.url ??= page?.url;
    // The chat keeps thumbnails only; the full images go to the agent.
    const thumbs = images.map((i) => i.thumb).filter(Boolean);
    this.emit(chat, {
      type: "user_message",
      text,
      url: page?.url,
      ...(thumbs.length ? { images: thumbs } : {}),
      ...(elements.length ? { elements: elements.map((e) => ({ selector: e.selector, label: e.label })) } : {}),
    });
    this.sendChat(chat);
    try {
      const sessionId = await this.ensureSession(chat);
      const context = page ? await pageContext(page) : "";
      const prompt: acp.ContentBlock[] = [
        { type: "text", text: context + pickedContext(elements) + text },
        ...images.map((i): acp.ContentBlock => ({ type: "image", mimeType: i.mimeType, data: i.data })),
      ];
      const res = await agent.conn!.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
      agent.auth.markWorking();
      if (!replaced()) this.emit(chat, { type: "turn_end", stopReason: res.stopReason });
    } catch (e) {
      if (replaced()) return;
      console.error(`[${agent.id}] prompt failed:`, e);
      const code = (e as { code?: number }).code;
      const authRequired = code === AUTH_REQUIRED;
      if (authRequired) agent.auth.markAuthRequired();
      this.error(
        chat,
        authRequired
          ? `Authenticate ${agent.name} to continue.`
          : code === -32601 // method not found, e.g. no session/new
            ? `${agent.name} can't start a conversation, so it can't be used with Eyepatch. Pick another agent from the New chat menu.`
            : String((e as Error).message ?? e),
      );
      this.emit(chat, { type: "turn_end", stopReason: "error" });
    } finally {
      if (!replaced()) {
        chat.busy = false;
        this.sendChat(chat);
        void this.saveHistory(chat);
      }
      agent.auth.refreshIfUnknown();
      if (this.pendingRestarts.has(agent.id) && !this.busyOn(agent.id)) {
        this.pendingRestarts.delete(agent.id);
        void agent.restart();
      }
    }
  }

  private async cancel(tabId: number) {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    this.cancelPermissions(chat);
    const agent = chat.agentId ? this.agents.get(chat.agentId) : undefined;
    if (chat.sessionId && chat.busy && agent?.conn) {
      await agent.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: chat.sessionId });
    }
  }

  // ---------- model and effort ----------

  /** The agent's model picker, or its effort (reasoning) level, if it has one. */
  private selectOption(chat: Chat, kind: "model" | "effort") {
    const category = kind === "model" ? "model" : "thought_level";
    const opt = chat.configOptions.find((o) => o.category === category && o.type === "select");
    return opt?.type === "select" ? opt : undefined;
  }

  private flatOptions(opt: NonNullable<ReturnType<Chats["selectOption"]>>) {
    return opt.options.flatMap((o) => ("group" in o ? o.options : [o]));
  }

  private optionView(chat: Chat, kind: "model" | "effort") {
    const opt = this.selectOption(chat, kind);
    if (!opt) return null;
    return {
      current: opt.currentValue,
      options: this.flatOptions(opt).map((o) => ({ value: o.value, name: o.name, description: o.description ?? null })),
    };
  }

  private async setOption(tabId: number, kind: "model" | "effort", value: string) {
    const chat = this.chat(tabId);
    try {
      const sessionId = await this.ensureSession(chat);
      const opt = this.selectOption(chat, kind);
      const agent = this.agentFor(chat);
      if (!opt || !agent?.conn) return;
      const res = await agent.conn.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: opt.id,
        value,
      });
      chat.configOptions = res.configOptions;
      await this.catalog.setPreferred(kind, agent.id, value);
    } catch (e) {
      this.error(chat, `Couldn't change the ${kind}: ${(e as Error).message}`);
    }
    this.sendChat(chat);
  }

  // ---------- permissions ----------

  private requestPermission(
    chat: Chat,
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    if (!this.extension.connected) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    // Read-only browser tools and reload_tab don't need a prompt. run_js still asks.
    if (UNPROMPTED_BROWSER_TOOL.test(params.toolCall.title ?? "")) {
      const allow = params.options.find((o) => o.kind === "allow_once");
      if (allow) return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    const id = `p${++this.permissionSeq}`;
    const guarded = guardedToolIn(params.toolCall.title ?? "");
    return new Promise((resolve) => {
      const done = (optionId: string | null) => {
        if (!this.permissions.has(id)) return;
        this.permissions.delete(id);
        // Remember it so the tool call itself doesn't ask a second time.
        const option = params.options.find((o) => o.optionId === optionId);
        const kind = option?.kind;
        if (guarded && kind === "allow_once") chat.approvals.set(guarded, Date.now());
        if (guarded && kind === "allow_always") chat.alwaysAllowed.add(guarded);
        this.emit(chat, { type: "permission_resolved", id, option: option ? { name: option.name, kind: option.kind } : null });
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      };
      (done as { tabId?: number }).tabId = chat.tabId;
      this.permissions.set(id, done);
      signal.addEventListener("abort", () => done(null), { once: true });
      this.emit(chat, { type: "permission_request", id, toolCall: params.toolCall, options: params.options });
    });
  }

  /**
   * A guarded tool is about to run. Fine if the user approved it through the
   * agent's own permission request just before (Claude asks); otherwise (e.g.
   * Codex approves tool calls itself) ask the user here.
   */
  private async approveTool(chat: Chat, tool: string, args: unknown): Promise<boolean> {
    if (chat.alwaysAllowed.has(tool)) return true;
    const at = chat.approvals.get(tool);
    if (at && Date.now() - at < APPROVAL_WINDOW_MS) {
      chat.approvals.delete(tool);
      return true;
    }
    const res = await this.requestPermission(
      chat,
      {
        sessionId: chat.sessionId ?? "",
        toolCall: { toolCallId: `eyepatch-${++this.permissionSeq}`, title: GUARDED_TOOLS[tool], rawInput: args },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow in this chat", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
      new AbortController().signal,
    );
    const choice = res.outcome.outcome === "selected" ? res.outcome.optionId : null;
    if (choice === "always") chat.alwaysAllowed.add(tool);
    return choice === "allow" || choice === "always";
  }

  private cancelPermissions(chat: Chat) {
    for (const done of [...this.permissions.values()]) {
      if ((done as { tabId?: number }).tabId === chat.tabId) done(null);
    }
  }

  // ---------- history ----------

  /** Save a chat to ~/.eyepatch/sessions/<session id>.json. */
  private async saveHistory(chat: Chat) {
    if (!chat.sessionId || !chat.events.some((e) => e.type === "user_message")) return;
    // Nothing new (a note about a restored chat doesn't count).
    if (!chat.events.slice(chat.saved).some((e) => e.type !== "note")) return;
    chat.saved = chat.events.length;
    const first = chat.events.find((e) => e.type === "user_message") as { text?: string } | undefined;
    const record = {
      sessionId: chat.sessionId,
      agentId: chat.agentId,
      agent: chat.agentId ? (this.agents.get(chat.agentId)?.name ?? this.catalog.nameOf(chat.agentId)) : null,
      title: (first?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      url: chat.url ?? null,
      createdAt: new Date(chat.createdAt).toISOString(),
      updatedAt: new Date().toISOString(),
      events: compact(chat.events),
    };
    const file = historyFile(chat.sessionId);
    await fs.writeFile(file, JSON.stringify(record)).catch((e) => console.warn("[chats] couldn't save history:", e.message));
    // A restored chat that went on in a new session replaces its old copy.
    if (chat.restoredFrom && chat.restoredFrom !== chat.sessionId) {
      await fs.rm(historyFile(chat.restoredFrom), { force: true });
      chat.restoredFrom = chat.sessionId;
    }
  }

  /** Saved chats, newest first. */
  private async listHistory(): Promise<HistoryItem[]> {
    const names = (await fs.readdir(SESSIONS_DIR).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const items: HistoryItem[] = [];
    for (const name of names) {
      const file = path.join(SESSIONS_DIR, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      let cached = this.historyIndex.get(file);
      if (cached?.mtimeMs !== stat.mtimeMs) {
        const r = await readRecord(file);
        const item = r && { sessionId: r.sessionId, agentId: r.agentId, agent: r.agent, title: r.title, url: r.url, updatedAt: r.updatedAt };
        this.historyIndex.set(file, (cached = { mtimeMs: stat.mtimeMs, item }));
      }
      if (cached.item) items.push(cached.item);
    }
    for (const file of this.historyIndex.keys()) if (!names.includes(path.basename(file))) this.historyIndex.delete(file);
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Show a saved chat in this tab and continue it. Like New chat, this ends the tab's current chat. */
  private async restore(tabId: number, sessionId: string) {
    const record = await readRecord(historyFile(sessionId));
    const chat = this.chat(tabId);
    if (!record) return this.error(chat, "That chat couldn't be found.");
    if (chat.sessionId === sessionId) return;
    await this.cancel(tabId);
    await this.endSession(chat);
    if (record.agentId && this.catalog.isInstalled(record.agentId)) chat.agentId = record.agentId;
    chat.events = record.events;
    chat.saved = record.events.length;
    chat.url = record.url ?? undefined;
    chat.createdAt = Date.parse(record.createdAt) || Date.now();
    chat.reopen = { sessionId: record.sessionId, agentId: record.agentId };
    chat.restoredFrom = record.sessionId;
    this.extension.send({ type: "transcript", tabId, events: chat.events });
    this.sendChat(chat);
    const agent = this.agentFor(chat);
    if (agent) {
      agent.auth.send();
      if (agent.ready) void this.ensureSession(chat).catch((e) => this.error(chat, String((e as Error).message ?? e)));
    }
    this.stopUnusedAgents();
  }
}

type SavedChat = HistoryItem & { createdAt: string; events: ChatEvent[] };

const historyFile = (sessionId: string) => path.join(SESSIONS_DIR, `${sessionId.replace(/[^\w.-]/g, "_")}.json`);

async function readRecord(file: string): Promise<SavedChat | null> {
  try {
    const r = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof r?.sessionId !== "string" || !Array.isArray(r.events)) return null;
    return {
      sessionId: r.sessionId,
      agentId: r.agentId ?? null,
      agent: r.agent ?? null,
      title: String(r.title ?? ""),
      url: r.url ?? null,
      createdAt: String(r.createdAt ?? ""),
      updatedAt: String(r.updatedAt ?? r.createdAt ?? ""),
      events: r.events,
    };
  } catch {
    return null;
  }
}
