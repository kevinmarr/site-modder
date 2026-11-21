import { createGmHost } from "./gm.js";
import { modApplies } from "./match.js";
import { toolTitle } from "./tool-names.js";
import { cssCode, removeCssCode, reportCode, scriptsFor } from "./userscripts.js";

// Eyepatch service worker: owns the WebSocket to Agent Bridge (the local
// program that runs the agents), runs browser tools for them, registers mods
// as user scripts, and relays each tab's chat between Agent Bridge and that
// tab's side panel. Every tab has its own side panel and its own chat.

const BRIDGE_PORT = 7457;
const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const PROBE_URL = `http://127.0.0.1:${BRIDGE_PORT}/`;
const MAX_TRANSCRIPT = 2000;
const MAX_SCREENSHOT_EDGE = 1568; // larger images get downscaled by the model API anyway

let ws = null;
let connected = false;
let agents = null; // agent catalog and install progress, from Agent Bridge
const auths = new Map(); // agent id -> sign-in state
const chats = new Map(); // tab id -> { agentId, agent, ready, busy, model, ... }
const transcripts = new Map(); // tab id -> chat events, replayed when its panel opens
const urlAtMessage = new Map(); // tab id -> the tab's URL when its latest message was sent
const tabRequests = new Map(); // id -> { tabId, event, finish }, for "switch to tab" cards
let tabRequestSeq = 0;
let modErrors = {}; // mod id -> registration error
let lastMods = new Map(); // mod id -> mod, to tell CSS-only changes apart
let modList = []; // every mod, without its code (for the side panel and Options page)
const gm = createGmHost({ onMenusChanged: (tabId) => broadcastState(tabId) });
const panels = new Map(); // tab id -> Set of ports (that tab's side panel)
const optionsPages = new Set(); // ports of open Options pages (setup and agents)

// ---------- one side panel per tab ----------

// No panel by default; the toolbar button turns one on for the current tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  // The button toggles: a tab whose panel is open (it holds a port) closes it.
  if (panels.has(tab.id) && chrome.sidePanel.close) {
    chrome.sidePanel.close({ tabId: tab.id }).catch((e) => console.warn("[eyepatch] close panel:", e));
    return;
  }
  // Both calls must happen synchronously in the click for open() to be allowed.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tab=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.warn("[eyepatch] open panel:", e));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  send({ type: "close_chat", tabId });
  forgetModsRan(tabId);
  gm.forgetTab(tabId);
  for (const [id, r] of tabRequests) if (r.tabId === tabId) r.finish({ accepted: false, reason: "the tab was closed" });
  chats.delete(tabId);
  transcripts.delete(tabId);
  urlAtMessage.delete(tabId);
  attention.delete(tabId);
});

// Chrome clears a tab's badge when it navigates; put it back.
// Console capture is per page load, too: start it again on each new page.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete") {
    offerInstall(tab);
    return checkPage(tabId);
  }
  if (info.status !== "loading") return;
  gm.navigationStarted(tabId);
  if (attention.has(tabId) || modsRan.has(tabId)) updateBadge(tabId);
  if (hasChat(tabId)) startCapture(tabId);
});

/** Tabs with a chat (panel open, or a session from earlier). Only these are watched. */
const hasChat = (tabId) => chats.has(tabId) || panels.has(tabId);

// ---------- Agent Bridge connection ----------

let probing = false;

async function connect() {
  if (probing) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // Chrome logs every refused WebSocket as an extension error, so check with a
  // plain fetch first and only open the socket once something is listening.
  // (Agent Bridge answers non-upgrade HTTP requests with 426; any response is fine.)
  probing = true;
  try {
    await fetch(PROBE_URL, { cache: "no-store" });
  } catch {
    // Agent Bridge not running. Retry fast while a panel is open; otherwise the alarm retries.
    if (panels.size || optionsPages.size) setTimeout(connect, 2000);
    return;
  } finally {
    probing = false;
  }
  if (ws) return;
  const socket = new WebSocket(BRIDGE_URL);
  ws = socket;
  socket.onopen = async () => {
    connected = true;
    const tabs = (await chrome.tabs.query({}).catch(() => [])).map((t) => t.id);
    send({ type: "hello", extensionVersion: chrome.runtime.getManifest().version, tabs });
    // Panels that are already open get their chat back.
    for (const tabId of panels.keys()) send({ type: "open_chat", tabId });
    if (optionsPages.size) send({ type: "options_open" });
    broadcastState();
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    connected = false;
    declineTabRequests("Agent Bridge disconnected");
    agents = null;
    auths.clear();
    for (const c of chats.values()) Object.assign(c, { ready: false, busy: false });
    broadcastState();
    setTimeout(connect, 2000);
  };
  socket.onerror = () => {};
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onBridgeMessage(msg).catch((e) => console.error("[eyepatch]", e));
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Service workers get suspended; an alarm brings us back to reconnect.
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "reconnect" && connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(({ reason }) => {
  connect();
  // The Options page doubles as setup.
  if (reason === "install") chrome.runtime.openOptionsPage();
});
connect();

async function onBridgeMessage(msg) {
  switch (msg.type) {
    case "ping":
      return;
    case "chat":
      chats.set(msg.tabId, msg.chat);
      updateBadge(msg.tabId);
      return broadcastState(msg.tabId);
    case "transcript":
      transcripts.set(msg.tabId, msg.events);
      for (const [id, r] of tabRequests) if (r.tabId === msg.tabId) transcripts.get(msg.tabId).push(r.event);
      return initPanels(msg.tabId);
    case "session_update":
    case "turn_end":
    case "error":
    case "user_message":
    case "permission_request":
    case "permission_resolved": {
      const { tabId, ...event } = msg;
      return record(tabId, event);
    }
    case "tool_call":
      return runTool(msg);
    case "auth":
      auths.set(msg.agentId, msg.auth);
      return broadcastState();
    case "agents":
      agents = msg.agents;
      return broadcastState();
    case "history":
      for (const p of panels.get(msg.tabId) ?? []) p.postMessage({ type: "history", items: msg.items });
      return;
    case "options_event":
      for (const p of optionsPages) p.postMessage(msg.event);
      return;
    case "reload_extension":
      return chrome.runtime.reload();
  }
}

// ---------- side panels ----------

/** Add an event to a tab's chat and show it. */
function record(tabId, event) {
  if (tabId == null) return;
  event.at ??= Date.now();
  let t = transcripts.get(tabId);
  if (!t) transcripts.set(tabId, (t = []));
  t.push(event);
  if (t.length > MAX_TRANSCRIPT) transcripts.set(tabId, t.slice(-MAX_TRANSCRIPT));
  for (const p of panels.get(tabId) ?? []) p.postMessage({ type: "event", event });
  attend(tabId, event).catch((e) => console.error("[eyepatch] attention:", e));
}

/** What a tab's side panel shows besides the chat itself. */
function state(tabId) {
  const chat = chats.get(tabId);
  return {
    bridge: {
      connected,
      agentId: chat?.agentId ?? null,
      agent: chat?.agent ?? null,
      ready: Boolean(chat?.ready),
      images: Boolean(chat?.images),
      busy: Boolean(chat?.busy),
      needsAgent: connected && Boolean(chat) && !chat.agentId,
    },
    auth: chat?.agentId ? (auths.get(chat.agentId) ?? null) : null,
    model: chat?.model ?? null,
    effort: chat?.effort ?? null,
    agents: agents && { ...agents, selected: chat?.agentId ?? null },
    userScripts: userScriptsAvailable(),
    modErrors,
    mods: modList,
    menuCommands: gm.menusFor(tabId),
    sessionId: chat?.sessionId ?? null,
  };
}

function initPanels(tabId) {
  for (const p of panels.get(tabId) ?? []) {
    p.postMessage({ type: "init", state: state(tabId), transcript: transcripts.get(tabId) ?? [] });
  }
}

/** Send fresh state to one tab's panel, or to every panel (and the Options page). */
function broadcastState(tabId) {
  const ids = tabId == null ? [...panels.keys()] : [tabId];
  for (const id of ids) for (const p of panels.get(id) ?? []) p.postMessage({ type: "state", state: state(id) });
  if (tabId == null) for (const p of optionsPages) p.postMessage({ type: "state", state: optionsState() });
}

/** What the Options page shows: setup steps and every installed agent's sign-in. */
function optionsState() {
  return { connected, agents, auths: Object.fromEntries(auths), userScripts: userScriptsAvailable(), mods: modList };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "options") return;
  optionsPages.add(port);
  connect();
  port.postMessage({ type: "state", state: optionsState() });
  // Agent Bridge starts the installed agents so their sign-in status shows.
  if (optionsPages.size === 1) send({ type: "options_open" });
  port.onDisconnect.addListener(() => {
    optionsPages.delete(port);
    if (!optionsPages.size) send({ type: "options_close" });
  });
  port.onMessage.addListener((msg) => {
    if (msg.type === "color_scheme") return setToolbarIcon(msg.dark);
    if (msg.type === "mod_delete") gm.forget(msg.id);
    if (["agent_install", "agent_remove", "agents_refresh", "auth_start", "auth_input", "auth_cancel", "auth_recheck", "mod_set_enabled", "mod_delete", "mod_reveal", "mod_export", "mod_import"].includes(msg.type)) send(msg);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  const m = /^sidepanel:(\d+)$/.exec(port.name);
  if (!m) return;
  const tabId = Number(m[1]);
  if (!panels.has(tabId)) panels.set(tabId, new Set());
  panels.get(tabId).add(port);
  startCapture(tabId);
  connect();
  port.postMessage({ type: "init", state: state(tabId), transcript: transcripts.get(tabId) ?? [] });
  // Agent Bridge sends the chat (and its history) back; it's the source of truth.
  send({ type: "open_chat", tabId });
  port.onDisconnect.addListener(() => {
    cancelPick(tabId); // the panel closed mid-pick
    panels.get(tabId)?.delete(port);
    if (!panels.get(tabId)?.size) panels.delete(tabId);
    panelVisible.delete(port);
  });
  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case "prompt": {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        urlAtMessage.set(tabId, tab?.url ?? null);
        send({ type: "prompt", tabId, text: msg.text, images: msg.images, elements: msg.elements, page: tab && { tabId, url: tab.url, title: tab.title } });
        break;
      }
      case "cancel":
        declineTabRequests("the user stopped the agent", tabId);
        send({ type: "cancel", tabId });
        break;
      case "new_session":
        declineTabRequests("the user started a new chat", tabId);
        send({ type: "new_session", tabId });
        break;
      case "set_model":
      case "set_effort":
      case "agent_select":
      case "history_list":
        send({ ...msg, tabId });
        break;
      case "history_restore": {
        // Already open in another tab: go there instead.
        const other = [...chats].find(([id, c]) => id !== tabId && c.sessionId === msg.sessionId)?.[0];
        if (other != null) focusConversation(other);
        else send({ ...msg, tabId });
        break;
      }
      case "mod_set_enabled":
        send(msg);
        break;
      case "menu_command":
        gm.runMenu(tabId, msg.modId, msg.id);
        break;
      case "pick_element": {
        // Resolves when the user clicks an element in the page, or with null (Escape, or cancelled).
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: pickElement }).catch(() => []);
        port.postMessage({ type: "picked", element: res?.result ?? null });
        break;
      }
      case "pick_cancel":
        cancelPick(tabId);
        break;
      case "tab_response":
        tabRequests.get(msg.id)?.finish(msg.accept ? { accepted: true } : { accepted: false, reason: "the user chose Not now" });
        break;
      case "permission_response":
        send({ type: "permission_response", id: msg.id, optionId: msg.optionId });
        break;
      case "color_scheme":
        setToolbarIcon(msg.dark);
        break;
      case "visibility":
        panelVisible.set(port, msg.visible);
        if (msg.visible) {
          const a = attention.get(tabId);
          if (a) a.unseenTurnEnd = false;
          updateBadge(tabId);
        }
        break;
    }
  });
});

// ---------- picking an element for the message (runs in the page) ----------

function cancelPick(tabId) {
  chrome.scripting
    .executeScript({ target: { tabId }, func: () => window.__eyepatchPick?.(null) })
    .catch(() => {});
}

/**
 * Highlight the element under the pointer and resolve with the one clicked:
 * a selector that finds it, a short label, and snippets of its HTML and text.
 * Escape resolves with null. Clicks don't reach the page while picking.
 */
function pickElement() {
  window.__eyepatchPick?.(null); // one picker at a time
  return new Promise((resolve) => {
    const box = document.createElement("div");
    const tag = document.createElement("div");
    const base = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;";
    box.style.cssText = base + "border:2px solid #19191b;background:rgba(25,25,27,.08);border-radius:3px;outline:1px solid #fff;display:none";
    tag.style.cssText =
      base + "padding:3px 7px;border-radius:5px;background:#19191b;color:#fff;font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none";
    document.documentElement.append(box, tag);
    let current = null;

    // "h1.title", "nav#toc", or for a bare tag its text: a “Second link”.
    const label = (el) => {
      let s = el.tagName.toLowerCase();
      if (el.id) return `${s}#${el.id}`;
      if (typeof el.className === "string" && el.className.trim()) return s + "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
      const text = (el.innerText ?? "").trim().replace(/\s+/g, " ");
      return text ? `${s} “${text.length > 24 ? text.slice(0, 23) + "…" : text}”` : s;
    };
    const unique = (sel) => {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch {
        return false;
      }
    };
    // Walk up from the element until the selector matches only it.
    const selectorFor = (el) => {
      if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        let part = n.tagName.toLowerCase();
        if (n.id && unique(`#${CSS.escape(n.id)}`)) {
          parts.unshift(`#${CSS.escape(n.id)}`);
          break;
        }
        const classes = [...n.classList].filter((c) => /^[a-z_-][\w-]*$/i.test(c) && c.length < 40).slice(0, 2);
        if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join("");
        const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
        parts.unshift(part);
        if (unique(parts.join(" > "))) break;
      }
      return parts.join(" > ");
    };

    const show = (el) => {
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      tag.textContent = label(el);
      const above = r.top > 28;
      Object.assign(tag.style, { display: "block", left: `${Math.max(4, r.left)}px`, top: above ? `${r.top - 26}px` : `${Math.min(innerHeight - 26, r.bottom + 4)}px` });
    };
    const finish = (result) => {
      window.__eyepatchPick = undefined;
      box.remove();
      tag.remove();
      for (const [type, fn] of handlers) removeEventListener(type, fn, true);
      resolve(result);
    };
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const handlers = [
      ["mousemove", (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== current && el !== box && el !== tag) show(el);
      }],
      ["click", (e) => {
        swallow(e);
        const el = current ?? document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;
        const clone = el.cloneNode(true);
        clone.querySelectorAll("script, style, svg").forEach((n) => (n.tagName === "svg" ? (n.innerHTML = "") : n.remove()));
        finish({
          selector: selectorFor(el),
          label: label(el),
          html: clone.outerHTML.slice(0, 3000),
          text: (el.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 300),
        });
      }],
      ["keydown", (e) => {
        if (e.key !== "Escape") return;
        swallow(e);
        finish(null);
      }],
      ["scroll", () => current && show(current)],
      ...["mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "dblclick", "contextmenu"].map((t) => [t, swallow]),
    ];
    for (const [type, fn] of handlers) addEventListener(type, fn, true);
    window.__eyepatchPick = finish;
  });
}

// ---------- browser tools (called by the agent) ----------

/** The tab a chat belongs to; its browser tools act on it. */
async function targetTab(tabId) {
  if (tabId == null) throw new Error("No tab given");
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error("This conversation's tab has been closed.");
  }
}

const BACKGROUND_TAB_HELP =
  "Chrome can only screenshot the tab the user is looking at, and they're on another tab. get_page_content, query_selector_all, run_js and get_console_logs still work on this tab; use them to verify instead.";

/**
 * Ask the user (via a card in the side panel, plus a notification if they're
 * not watching it) to switch back to `tab` so it can be screenshotted. There's
 * deliberately no timeout: the agent waits until the user acts. Resolves
 * { ok: true } once the tab is visible: they clicked "Switch to tab" or
 * switched to it themselves. Otherwise { ok: false, reason }.
 */
function requestTabSwitch(tab) {
  const id = `t${++tabRequestSeq}`;
  const event = { type: "tab_request", id, tabId: tab.id, title: tab.title, url: tab.url, purpose: "take a screenshot" };
  return new Promise((resolve) => {
    // byUser: they activated the tab themselves, so there's nothing to switch.
    const finish = async ({ accepted, reason, byUser = false }) => {
      if (!tabRequests.has(id)) return;
      tabRequests.delete(id);
      chrome.tabs.onActivated.removeListener(onActivated);
      if (accepted) {
        try {
          if (!byUser) {
            await chrome.tabs.update(tab.id, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          await new Promise((r) => setTimeout(r, 400)); // let it paint
        } catch (e) {
          // Only a failure if the tab didn't end up in front anyway.
          const now = await chrome.tabs.get(tab.id).catch(() => null);
          if (!now?.active) {
            accepted = false;
            reason = `switching to the tab failed: ${e?.message ?? e}`;
          }
        }
      }
      console.log(`[eyepatch] tab request ${id}:`, accepted ? "switched" : reason);
      record(tab.id, { type: "tab_request_resolved", id, accepted, reason });
      resolve(accepted ? { ok: true } : { ok: false, reason });
    };
    const onActivated = (info) => info.tabId === tab.id && finish({ accepted: true, byUser: true });
    chrome.tabs.onActivated.addListener(onActivated);
    tabRequests.set(id, { tabId: tab.id, event, finish });
    record(tab.id, event);
  });
}

/** Resolve open tab requests (for one tab, or all) as declined. */
function declineTabRequests(reason, tabId) {
  for (const r of [...tabRequests.values()]) if (tabId == null || r.tabId === tabId) r.finish({ accepted: false, reason });
}

/** Origin + path, ignoring query and hash (tracking params, in-page anchors). */
function pageKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url ?? "";
  }
}

/** A note for the agent if its tab has navigated since the user's message. */
async function navigationWarning(tabId) {
  const before = urlAtMessage.get(tabId);
  if (tabId == null || !before) return undefined;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || pageKey(tab.url) === pageKey(before)) return undefined;
  return `Note: the user navigated this tab from ${before} to ${tab.url} since their message; this result is from the new page.`;
}

function userScriptsAvailable() {
  try {
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

// Chrome has no event for the "Allow User Scripts" toggle, so check while a
// side panel or the Options page is open (both ask for it).
let userScriptsOn = userScriptsAvailable();
function checkUserScripts() {
  const on = userScriptsAvailable();
  if (on === userScriptsOn) return;
  userScriptsOn = on;
  broadcastState();
  // Just turned on: have Agent Bridge send the mods again so they get registered.
  if (on) send({ type: "sync_mods" });
}
setInterval(() => (panels.size || optionsPages.size) && checkUserScripts(), 1000);

const USER_SCRIPTS_HELP =
  'User scripts are disabled. Open chrome://extensions, click "Details" on Eyepatch and turn on "Allow User Scripts".';

async function inPage(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const tools = {
  async get_tab({ tabId }) {
    const tab = await targetTab(tabId);
    const before = urlAtMessage.get(tabId) ?? null;
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      urlAtMessage: before,
      navigatedSinceMessage: before != null && pageKey(tab.url) !== pageKey(before),
      userIsViewingIt: tab.active,
    };
  },

  async get_page_content({ tabId, selector, format = "html", maxChars = 30000 }) {
    const tab = await targetTab(tabId);
    return inPage(
      tab.id,
      (selector, format, maxChars) => {
        const el = selector ? document.querySelector(selector) : document.body;
        if (!el) return { error: `No element matches ${selector}` };
        let content;
        if (format === "text") {
          content = el.innerText;
        } else {
          const clone = el.cloneNode(true);
          clone.querySelectorAll("script, style, noscript, link[rel=stylesheet]").forEach((n) => n.remove());
          clone.querySelectorAll("svg").forEach((n) => (n.innerHTML = ""));
          for (const n of [clone, ...clone.querySelectorAll("*")]) {
            for (const a of [...n.attributes]) {
              if (a.value.length > 200) n.setAttribute(a.name, a.value.slice(0, 200) + "…");
            }
          }
          content = clone.outerHTML;
        }
        return {
          length: content.length,
          truncated: content.length > maxChars,
          content: content.slice(0, maxChars),
        };
      },
      [selector ?? null, format, maxChars],
    );
  },

  async query_selector_all({ tabId, selector, limit = 20 }) {
    const tab = await targetTab(tabId);
    return inPage(
      tab.id,
      (selector, limit) => {
        const all = [...document.querySelectorAll(selector)];
        return {
          total: all.length,
          elements: all.slice(0, limit).map((el) => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              classes: [...el.classList],
              attributes: Object.fromEntries(
                [...el.attributes]
                  .filter((a) => a.name.startsWith("data-") || a.name.startsWith("aria-") || a.name === "role")
                  .map((a) => [a.name, a.value.slice(0, 100)]),
              ),
              text: (el.innerText ?? "").trim().slice(0, 150),
              visible: r.width > 0 && r.height > 0,
              html: el.outerHTML.slice(0, 300),
            };
          }),
        };
      },
      [selector, limit],
    );
  },

  async run_js({ tabId, code, world = "isolated" }) {
    if (!userScriptsAvailable()) throw new Error(USER_SCRIPTS_HELP);
    const tab = await targetTab(tabId);
    const [res] = await chrome.userScripts.execute({
      target: { tabId: tab.id },
      js: [{ code }],
      world: world === "main" ? "MAIN" : "USER_SCRIPT",
    });
    if (res?.error) throw new Error(res.error);
    return res?.result === undefined ? "undefined" : res.result;
  },

  async screenshot({ tabId }) {
    let tab = await targetTab(tabId);
    if (!tab.active) {
      const { ok, reason } = await requestTabSwitch(tab);
      if (!ok) throw new Error(`The user didn't switch back to the tab (${reason}). ${BACKGROUND_TAB_HELP}`);
      tab = await targetTab(tabId);
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    // Capture is in device pixels (2x on Retina). Scale to CSS pixels so image
    // coordinates match getBoundingClientRect, capped at the model's image size.
    const cssWidth = (await inPage(tab.id, () => window.innerWidth).catch(() => null)) ?? tab.width;
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const width = Math.min(bmp.width, cssWidth || bmp.width, MAX_SCREENSHOT_EDGE);
    const scale = width / bmp.width;
    const height = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bmp, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return {
      base64: await blobToBase64(blob),
      width,
      height,
      viewportWidth: cssWidth,
      cssPxPerImagePx: cssWidth ? cssWidth / width : null,
    };
  },

  async get_console_logs({ tabId, limit = 50, levels }) {
    if (!userScriptsAvailable()) throw new Error(USER_SCRIPTS_HELP);
    const tab = await targetTab(tabId);
    const read = `(() => { const b = globalThis.__smConsole; return b ? b.slice() : null; })()`;
    const entries = [];
    let installed = false;
    for (const world of ["USER_SCRIPT", "MAIN"]) {
      const [res] = await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: read }], world });
      if (Array.isArray(res?.result)) entries.push(...res.result);
      else {
        await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: captureCode(world) }], world, injectImmediately: true });
        installed = true;
      }
    }
    const wanted = levels?.length ? entries.filter((e) => levels.includes(e.level)) : entries;
    wanted.sort((a, b) => a.t - b.t);
    return {
      note: installed
        ? "Console capture was not active on this page and has been started now. Call reload_tab and then get_console_logs again to see messages from page load."
        : undefined,
      total: wanted.length,
      entries: wanted.slice(-limit).map((e) => ({ ...e, t: new Date(e.t).toISOString().slice(11, 23) })),
    };
  },

  async apply_mods({ mods, changed, reloadTabs }) {
    await syncMods(mods, changed ?? [], reloadTabs ?? null);
    return { errors: modErrors };
  },

  async reload_tab({ tabId }) {
    const tab = await targetTab(tabId);
    await reloadAndWait(tab.id);
    return "reloaded";
  },
};

async function runTool({ id, method, params }) {
  try {
    const fn = tools[method];
    if (!fn) throw new Error(`Unknown browser method ${method}`);
    const result = await fn(params ?? {});
    const warning = method === "apply_mods" ? undefined : await navigationWarning(params?.tabId);
    send({ type: "tool_result", id, result, warning });
  } catch (e) {
    // Navigation often explains the failure (e.g. the tab is now on chrome://).
    const warning = method === "apply_mods" ? undefined : await navigationWarning(params?.tabId).catch(() => undefined);
    send({ type: "tool_result", id, error: [warning, String(e?.message ?? e)].filter(Boolean).join("\n") });
  }
}

function reloadAndWait(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
  });
}

// ---------- mods -> user scripts ----------

/**
 * Console capture for one JS world. Each world (the page's MAIN world and the
 * USER_SCRIPT world mods run in) has its own globals and console, so this is
 * injected into both. Read back by get_console_logs.
 */
function captureCode(world) {
  return `(() => {
  if (globalThis.__smConsole) return;
  const buf = (globalThis.__smConsole = []);
  const fmt = (a) => {
    try {
      if (a instanceof Error) return a.stack || String(a);
      if (a && typeof a === "object") return JSON.stringify(a);
    } catch {}
    return String(a);
  };
  const push = (level, args) => {
    buf.push({ t: Date.now(), world: ${JSON.stringify(world === "MAIN" ? "page" : "mods")}, level, text: args.map(fmt).join(" ").slice(0, 2000) });
    if (buf.length > 300) buf.shift();
  };
  for (const level of ["error", "warn", "log", "info"]) {
    const orig = console[level];
    console[level] = function (...args) {
      push(level, args);
      return orig.apply(this, args);
    };
  }
  addEventListener("error", (e) => push("uncaught", [e.error || e.message]));
  addEventListener("unhandledrejection", (e) => push("unhandledrejection", [e.reason]));
})();`;
}

/**
 * Capture console output in a chat's tab (both worlds). Only chat tabs: the
 * wrapper puts our code on the stack of every console.error, so Chrome files
 * the page's own errors under Eyepatch.
 */
function startCapture(tabId) {
  if (!userScriptsAvailable()) return;
  for (const world of ["USER_SCRIPT", "MAIN"]) {
    chrome.userScripts
      .execute({ target: { tabId }, js: [{ code: captureCode(world) }], world, injectImmediately: true })
      .catch(() => {}); // e.g. chrome:// pages
  }
}

async function tabsMatching(mod) {
  try {
    return (await chrome.tabs.query({ url: mod.matches })).filter((t) => t.url && modApplies(mod, t.url));
  } catch {
    return [];
  }
}

/**
 * Register mods as user scripts and apply changes to open tabs: CSS hot-swaps
 * everywhere; other changes reload `reloadTabs` (the tabs whose agent made
 * them), or every matching tab when that's null.
 */
async function syncMods(mods, changed, reloadTabs = null) {
  modList = mods.map(({ js, sections, requires, resources, info, ...m }) => m);
  if (!userScriptsAvailable()) {
    broadcastState();
    return;
  }
  // Lets mods' report scripts message the extension.
  await chrome.userScripts.configureWorld({ messaging: true }).catch((e) => console.warn("[eyepatch] configureWorld:", e));
  const existing = await chrome.userScripts.getScripts();
  const ours = existing.filter((s) => s.id.startsWith("mod:") || s.id.startsWith("sm:")).map((s) => s.id);
  if (ours.length) await chrome.userScripts.unregister({ ids: ours });

  const tokenFor = await gm.setMods(mods);
  modErrors = {};
  for (const mod of mods) {
    if (mod.error) {
      modErrors[mod.id] = mod.error;
      continue;
    }
    // Register per mod so one bad match pattern doesn't block the rest.
    const scripts = scriptsFor(mod, chrome.runtime.getManifest().version, tokenFor(mod.id));
    if (!scripts.length) continue;
    try {
      await chrome.userScripts.register(scripts);
    } catch (e) {
      modErrors[mod.id] = String(e?.message ?? e);
    }
  }

  // Apply changes to open tabs: styles hot-swap, scripts reload.
  const next = new Map(mods.map((m) => [m.id, m]));
  const live = (m) => m && !m.error && m.enabled;
  const toReload = new Set();
  const hotSwaps = [];
  for (const id of changed) {
    const before = lastMods.get(id);
    const after = next.get(id);
    const isStyle = (m) => !m || m.kind === "css";
    if (isStyle(before) && isStyle(after)) {
      // Update the styles wherever the mod applied or now applies; turning
      // one on or off needs no reload either.
      const tabs = new Map();
      for (const m of [before, after]) if (live(m)) for (const t of await tabsMatching(m)) tabs.set(t.id, t);
      if (live(before) && !live(after)) for (const t of tabs.values()) forgetModRan(t.id, id);
      const code = live(after) ? cssCode(after) : removeCssCode(id);
      for (const t of tabs.values()) {
        hotSwaps.push(chrome.userScripts.execute({ target: { tabId: t.id, allFrames: true }, js: [{ code }] }).catch(() => {}));
        if (live(after) && !live(before)) hotSwaps.push(chrome.userScripts.execute({ target: { tabId: t.id }, js: [{ code: reportCode(after) }] }).catch(() => {}));
      }
    } else {
      for (const m of [before, after]) {
        if (!m?.matches?.length) continue;
        for (const t of await tabsMatching(m)) if (!reloadTabs || reloadTabs.includes(t.id)) toReload.add(t.id);
      }
    }
  }
  if (!countedOpenTabs) {
    countedOpenTabs = true;
    await countModsInOpenTabs(mods);
  }

  // Resolve only once changes are visible, so the agent's next tool call
  // (which Agent Bridge holds until this returns) sees the new page.
  lastMods = next;
  await Promise.all([...hotSwaps, ...[...toReload].map((tabId) => reloadAndWait(tabId))]);
  broadcastState();
  for (const [id, error] of Object.entries(modErrors)) {
    if (!changed.includes(id)) continue;
    for (const tabId of reloadTabs ?? panels.keys()) record(tabId, { type: "error", message: `Mod "${id}": ${error}` });
  }
}


// ---------- attention: notifications + toolbar badge ----------
// Agents keep working with the side panel closed or another tab in front.
// When one finishes or needs the user, and the user isn't watching that
// tab's panel, notify them. Each tab's toolbar badge shows its own state.

const panelVisible = new Map(); // port -> whether that panel is visible
const attention = new Map(); // tab id -> { permissions: Set, unseenTurnEnd, finalText }
const notificationTabs = new Map(); // notification id -> tab id

function attentionFor(tabId) {
  let a = attention.get(tabId);
  if (!a) attention.set(tabId, (a = { permissions: new Set(), unseenTurnEnd: false, finalText: "" }));
  return a;
}

/** Whether the user is looking at this tab's side panel right now. */
async function userIsWatching(tabId) {
  if (![...(panels.get(tabId) ?? [])].some((p) => panelVisible.get(p))) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active) return false;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return Boolean(win?.focused);
}

async function notify(tabId, id, { title, message, sticky = false }) {
  if (await userIsWatching(tabId)) return;
  notificationTabs.set(id, tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: message || " ",
    contextMessage: tab?.title ? clip(tab.title, 60) : undefined,
    requireInteraction: sticky,
    priority: sticky ? 2 : 0,
  });
}

function clearNotification(id) {
  notificationTabs.delete(id);
  chrome.notifications.clear(id).catch(() => {});
}

/** Bring a chat's tab forward with its side panel open. */
function focusConversation(tabId) {
  // sidePanel.open needs the click's user gesture, which ends at the first
  // await, so open the panel before anything else.
  chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tab=${tabId}`, enabled: true });
  chrome.sidePanel.open({ tabId }).catch((e) => console.warn("[eyepatch] open panel:", e));
  chrome.tabs
    .update(tabId, { active: true })
    .then((tab) => chrome.windows.update(tab.windowId, { focused: true }))
    .catch(() => {});
}

chrome.notifications.onClicked.addListener((id) => {
  const tabId = notificationTabs.get(id);
  clearNotification(id);
  if (tabId != null) focusConversation(tabId);
});
chrome.notifications.onClosed.addListener((id) => notificationTabs.delete(id));

const clip = (s, n = 180) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

async function attend(tabId, event) {
  const a = attentionFor(tabId);
  switch (event.type) {
    case "user_message":
      a.finalText = "";
      a.unseenTurnEnd = false;
      break;
    case "session_update": {
      const u = event.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") a.finalText += u.content.text;
      else if (u.sessionUpdate === "tool_call") a.finalText = "";
      return;
    }
    case "permission_request": {
      a.permissions.add(event.id);
      await notify(tabId, `perm:${event.id}`, {
        title: "Eyepatch needs your permission",
        message: clip(event.toolCall?.title ? toolTitle(event.toolCall).replace(/`/g, "") : "The agent wants to run a tool"),
        sticky: true,
      });
      break;
    }
    case "permission_resolved":
      a.permissions.delete(event.id);
      clearNotification(`perm:${event.id}`);
      break;
    case "tab_request":
      await notify(tabId, `tab:${event.id}`, {
        title: "Come back to this tab",
        message: clip(`The agent is waiting to ${event.purpose} of “${event.title || event.url}”.`),
        sticky: true,
      });
      break;
    case "tab_request_resolved":
      clearNotification(`tab:${event.id}`);
      break;
    case "turn_end": {
      if (event.stopReason === "cancelled") break; // the user stopped it; they know
      a.unseenTurnEnd = !(await userIsWatching(tabId));
      const failed = event.stopReason === "error" || event.stopReason === "refusal";
      await notify(tabId, `done:${tabId}:${Date.now()}`, {
        title: failed ? "Eyepatch stopped with an error" : "Eyepatch is done",
        message: clip(a.finalText) || (failed ? "Open the side panel for details." : "The agent finished its turn."),
      });
      break;
    }
    default:
      return;
  }
  updateBadge(tabId);
}

// Chrome draws the badge; one set of colors works on light and dark toolbars.
const BADGE = {
  needsYou: ["!", "#D93025"],
  working: ["•••", "#1A73E8"],
  done: ["✓", "#188038"],
  mods: [null, "#5F6368"],
};

function updateBadge(tabId) {
  const a = attention.get(tabId);
  const waiting = a?.permissions.size || [...tabRequests.values()].some((r) => r.tabId === tabId);
  let badge = ["", BADGE.mods[1]];
  if (waiting) badge = BADGE.needsYou;
  else if (chats.get(tabId)?.busy) badge = BADGE.working;
  else if (a?.unseenTurnEnd) badge = BADGE.done;
  else if (modsRan.get(tabId)?.ids.size) badge = [String(modsRan.get(tabId).ids.size), BADGE.mods[1]];
  const [text, color] = badge;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" }).catch(() => {});
}

// The toolbar icon is black; on a dark toolbar use the white one. Pages report
// Chrome's color scheme (the service worker can't see it).
async function setToolbarIcon(dark) {
  if (dark == null) dark = (await chrome.storage.local.get("darkToolbar")).darkToolbar ?? false;
  else chrome.storage.local.set({ darkToolbar: dark });
  const suffix = dark ? "-dark" : "";
  chrome.action.setIcon({ path: { 16: `icons/icon16${suffix}.png`, 32: `icons/icon32${suffix}.png` } }).catch(() => {});
}
setToolbarIcon();

// ---------- mods running in each tab ----------
// Each enabled mod has a tiny script that reports when it runs in a page, so
// the toolbar badge can count them without the extension looking at tabs.

const modsRan = new Map(); // tab id -> { documentId, ids: Set of mod ids }

// The service worker can restart; keep the counts across that.
const modsRanLoaded = chrome.storage.session
  .get("modsRan")
  .then(({ modsRan: saved }) => {
    for (const [tabId, r] of Object.entries(saved ?? {})) {
      if (!modsRan.has(Number(tabId))) modsRan.set(Number(tabId), { documentId: r.documentId, ids: new Set(r.ids) });
    }
  })
  .catch(() => {});

function saveModsRan() {
  const out = {};
  for (const [tabId, r] of modsRan) out[tabId] = { documentId: r.documentId, ids: [...r.ids] };
  chrome.storage.session.set({ modsRan: out }).catch(() => {});
}

function forgetModsRan(tabId) {
  if (modsRan.delete(tabId)) saveModsRan();
}

/** A mod stopped running in a tab without a reload (a style turned off). */
function forgetModRan(tabId, modId) {
  if (!modsRan.get(tabId)?.ids.delete(modId)) return;
  saveModsRan();
  updateBadge(tabId);
}

chrome.runtime.onUserScriptMessage?.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "gm") return gm.onMessage(msg, sender, sendResponse);
  const tabId = sender.tab?.id;
  if (msg?.type !== "mod_ran" || typeof msg.id !== "string" || tabId == null || sender.frameId !== 0) return;
  void modsRanLoaded.then(() => {
    let r = modsRan.get(tabId);
    if (!r || r.documentId !== sender.documentId) modsRan.set(tabId, (r = { documentId: sender.documentId, ids: new Set() }));
    r.ids.add(msg.id);
    saveModsRan();
    updateBadge(tabId);
  });
});
chrome.runtime.onUserScriptConnect?.addListener((port) => gm.onConnect(port));

/**
 * A tab finished loading. If it's on a new page, the mods that reported from
 * the old one (and its menu commands) are stale.
 */
async function checkPage(tabId) {
  await modsRanLoaded;
  const r = modsRan.get(tabId);
  const commands = gm.menusFor(tabId).length;
  if (!r && !commands) return;
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => 0 }).catch(() => []);
  if (commands) gm.pruneMenus(tabId, res?.documentId);
  if (!r || res?.documentId === r.documentId) return;
  forgetModsRan(tabId);
  updateBadge(tabId);
}

let countedOpenTabs = false;

/**
 * Pages loaded before the extension (re)started have mods running but never
 * reported them. Have each running mod report from the tabs it applies to.
 */
async function countModsInOpenTabs(mods) {
  await modsRanLoaded;
  for (const mod of mods) {
    if (mod.error || !mod.enabled) continue;
    for (const tab of await tabsMatching(mod)) {
      if (!tab.url || !modApplies(mod, tab.url) || modsRan.get(tab.id)?.ids.has(mod.id)) continue;
      chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: reportCode(mod) }] }).catch(() => {});
    }
  }
}

// ---------- installing userscripts from the web ----------
// Opening a .user.js or .user.css URL (e.g. Greasy Fork's Install button)
// offers to install it, as userscript managers do.

const offered = new Set(); // "tabId url" already offered

function offerInstall(tab) {
  let url;
  try {
    url = new URL(tab?.url ?? "");
  } catch {
    return;
  }
  if (!/^https?:$/.test(url.protocol) || !/\.user\.(js|css)$/i.test(url.pathname)) return;
  const key = `${tab.id} ${url.href}`;
  if (offered.has(key)) return;
  offered.add(key);
  chrome.tabs.create({ url: `options.html?install=${encodeURIComponent(url.href)}`, index: tab.index + 1, openerTabId: tab.id }).catch(() => {});
}
