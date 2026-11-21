// The extension's side of the userscript GM API (the page side is gmRuntime
// in userscripts.js). Scripts in the USER_SCRIPT world message the service
// worker; each request names its mod, and is only served if that mod is
// running and @grants the function.

import { modApplies } from "./match.js";

/**
 * @param {object} opts
 * @param {(tabId?: number) => void} opts.onMenusChanged a tab's menu commands changed (or every tab's)
 */
export function createGmHost({ onMenusChanged }) {
  // ---------- the running mods ----------
  // What requests are checked against: each running mod's grants, @connect
  // hosts and pages, and a random token that's built into its registered
  // code, so one mod can't make requests as another (they share a world).
  // Saved, because registered scripts keep running after the service worker
  // restarts, or while Agent Bridge isn't running.

  let mods = new Map(); // mod id -> { id, name, enabled, grants, connects, matches, excludeMatches, filter, token }
  const modsLoaded = chrome.storage.local
    .get("gmMods")
    .then(({ gmMods }) => {
      if (!mods.size) mods = new Map(Object.entries(gmMods ?? {}));
      onMenusChanged();
    })
    .catch(() => {});

  const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

  /** Agent Bridge sent the mods (before they're registered). Returns each mod's token. */
  async function setMods(list) {
    await modsLoaded;
    const next = new Map();
    for (const m of list) {
      if (m.error || !m.enabled || m.kind !== "js") continue;
      const { id, name, enabled, grants, connects, matches, excludeMatches, filter } = m;
      next.set(id, { id, name, enabled, grants: grants ?? [], connects: connects ?? [], matches, excludeMatches, filter, token: mods.get(id)?.token ?? randomToken() });
    }
    mods = next;
    await chrome.storage.local.set({ gmMods: Object.fromEntries(mods) }).catch(() => {});
    onMenusChanged();
    return (id) => mods.get(id)?.token;
  }

  const getMod = (id) => mods.get(id);
  // ---------- storage ----------
  // Each mod's values live in chrome.storage.local under "gmv:<mod id>".

  const key = (modId) => `gmv:${modId}`;
  const writes = new Map(); // mod id -> promise of the last write, so writes apply in order

  async function readValues(modId) {
    return (await chrome.storage.local.get(key(modId)))[key(modId)] ?? {};
  }

  function update(modId, fn) {
    const next = (writes.get(modId) ?? Promise.resolve()).then(async () => {
      const values = await readValues(modId);
      fn(values);
      await chrome.storage.local.set({ [key(modId)]: values });
    });
    writes.set(modId, next.catch(() => {}));
    return next;
  }

  // Other pages running the mod get changes too (coalesced, since some
  // scripts write on every scroll or keystroke).
  const pending = new Map(); // mod id -> Map(key -> { value, deleted })
  let flushTimer = null;
  function broadcast(modId, k, value, deleted) {
    if (!pending.has(modId)) pending.set(modId, new Map());
    pending.get(modId).set(k, { value, deleted });
    flushTimer ??= setTimeout(flush, 200);
  }
  async function flush() {
    flushTimer = null;
    await modsLoaded;
    const batch = [...pending];
    pending.clear();
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const [modId, changes] of batch) {
      const mod = getMod(modId);
      if (!mod) continue;
      const calls = [...changes].map(([k, c]) => `m.value(${JSON.stringify(k)}, ${JSON.stringify(c.value ?? null)}, ${c.deleted});`).join("\n");
      const code = `(() => { const m = globalThis.__eyepatchGM?.mods.get(${JSON.stringify(modId)}); if (!m) return;\n${calls}\n})();`;
      for (const tab of tabs) {
        if (!tab.url || !modApplies(mod, tab.url)) continue;
        chrome.userScripts.execute({ target: { tabId: tab.id, allFrames: true }, js: [{ code }] }).catch(() => {});
      }
    }
  }

  /** Forget a deleted mod's values. */
  function forget(modId) {
    chrome.storage.local.remove(key(modId)).catch(() => {});
  }

  // ---------- menu commands ----------
  // Shown in the side panel's menu under their mod. Kept in session storage
  // so they survive the service worker restarting.

  const menus = new Map(); // tab id -> [{ modId, id, caption, frameId, documentId }]
  const menusLoaded = chrome.storage.session
    .get("gmMenus")
    .then(({ gmMenus }) => {
      for (const [tabId, list] of Object.entries(gmMenus ?? {})) if (!menus.has(Number(tabId))) menus.set(Number(tabId), list);
    })
    .catch(() => {});
  function saveMenus(tabId) {
    chrome.storage.session.set({ gmMenus: Object.fromEntries(menus) }).catch(() => {});
    onMenusChanged(tabId);
  }

  function setMenu(tabId, entry, remove = false) {
    let list = menus.get(tabId) ?? [];
    // A new page in the tab: its old commands are gone.
    if (entry.frameId === 0) list = list.filter((c) => c.frameId !== 0 || c.documentId === entry.documentId);
    list = list.filter((c) => !(c.modId === entry.modId && c.id === entry.id && c.documentId === entry.documentId));
    if (!remove) list.push(entry);
    if (list.length) menus.set(tabId, list);
    else menus.delete(tabId);
    saveMenus(tabId);
  }

  /** The menu commands for a tab's side panel, of mods still running. */
  function menusFor(tabId) {
    return (menus.get(tabId) ?? []).filter((c) => getMod(c.modId)).map(({ modId, id, caption }) => ({ modId, id, caption }));
  }

  const loadStarts = new Map(); // tab id -> when its latest page started loading

  function navigationStarted(tabId) {
    loadStarts.set(tabId, Date.now());
  }

  /**
   * The tab finished loading and its top page is `documentId`: drop commands
   * from earlier pages (and from frames of earlier pages).
   */
  async function pruneMenus(tabId, documentId) {
    await menusLoaded;
    const list = menus.get(tabId);
    if (!list) return;
    const since = loadStarts.get(tabId) ?? 0;
    const next = list.filter((c) => (c.frameId === 0 ? c.documentId === documentId : c.at >= since));
    if (next.length === list.length) return;
    if (next.length) menus.set(tabId, next);
    else menus.delete(tabId);
    saveMenus(tabId);
  }

  function forgetTab(tabId) {
    loadStarts.delete(tabId);
    if (menus.delete(tabId)) saveMenus(tabId);
  }

  async function runMenu(tabId, modId, id) {
    await menusLoaded;
    const entry = (menus.get(tabId) ?? []).find((c) => c.modId === modId && c.id === id);
    if (!entry) return;
    const code = `globalThis.__eyepatchGM?.mods.get(${JSON.stringify(modId)})?.menu(${JSON.stringify(id)});`;
    await chrome.userScripts
      .execute({ target: { tabId, documentIds: [entry.documentId] }, js: [{ code }] })
      .catch((e) => console.warn("[eyepatch] menu command:", e));
  }

  // ---------- requests from pages ----------

  const STORAGE = ["getValue", "setValue", "deleteValue", "listValues", "getValues", "setValues", "deleteValues", "addValueChangeListener"];
  const NEEDS = {
    values: STORAGE,
    set: STORAGE,
    delete: STORAGE,
    openInTab: ["openInTab"],
    closeTab: ["openInTab"],
    notification: ["notification"],
    menuRegister: ["registerMenuCommand"],
    menuUnregister: ["registerMenuCommand", "unregisterMenuCommand"],
  };
  const openedTabs = new Map(); // tab id -> mod id that opened it

  /** The mod a page's request is for, if it's running and grants `method`. */
  async function check(modId, token, method) {
    await modsLoaded;
    const mod = getMod(modId);
    if (!mod || mod.token !== token) throw new Error(`mod ${modId} isn't running`);
    if (!(NEEDS[method] ?? []).some((g) => mod.grants?.includes(g))) throw new Error(`${method} needs a @grant`);
    return mod;
  }

  async function handle({ mod: modId, token, method, args = [] }, sender) {
    const mod = await check(modId, token, method);
    const tabId = sender.tab?.id;
    switch (method) {
      case "values":
        return readValues(modId);
      case "set": {
        const [k, value] = args;
        await update(modId, (v) => (v[k] = value));
        broadcast(modId, k, value, false);
        return null;
      }
      case "delete": {
        const [k] = args;
        await update(modId, (v) => delete v[k]);
        broadcast(modId, k, null, true);
        return null;
      }
      case "openInTab": {
        const [url, active] = args;
        if (!/^(https?|ftp|file|data|blob):/i.test(url)) throw new Error(`can't open ${url}`);
        const opener = sender.tab;
        const tab = await chrome.tabs.create({ url, active: Boolean(active), ...(opener ? { index: opener.index + 1, openerTabId: opener.id, windowId: opener.windowId } : {}) });
        openedTabs.set(tab.id, modId);
        return tab.id;
      }
      case "closeTab": {
        const [id] = args;
        if (openedTabs.get(id) !== modId) throw new Error("can only close tabs this script opened");
        openedTabs.delete(id);
        await chrome.tabs.remove(id).catch(() => {});
        return null;
      }
      case "notification": {
        const [{ title, text, image } = {}] = args;
        const opts = { type: "basic", iconUrl: image || "icons/icon128.png", title: String(title || mod.name), message: String(text ?? "") || " " };
        await chrome.notifications.create(`gm:${modId}:${Date.now()}`, opts).catch(() => chrome.notifications.create({ ...opts, iconUrl: "icons/icon128.png" }));
        return null;
      }
      case "menuRegister":
      case "menuUnregister": {
        if (tabId == null) return null;
        await menusLoaded;
        const [id, caption] = args;
        setMenu(tabId, { modId, id: String(id), caption: String(caption ?? ""), frameId: sender.frameId, documentId: sender.documentId, at: Date.now() }, method === "menuUnregister");
        return null;
      }
    }
    throw new Error(`unknown method ${method}`);
  }

  /** chrome.runtime.onUserScriptMessage, for { type: "gm" } messages. */
  function onMessage(msg, sender, sendResponse) {
    handle(msg, sender).then(
      (result) => sendResponse({ result }),
      (e) => sendResponse({ error: String(e?.message ?? e) }),
    );
    return true;
  }

  // ---------- GM_xmlhttpRequest ----------

  /** Whether `@connect` lets the mod reach this URL from this page. */
  function connectAllowed(mod, url, pageUrl) {
    const host = url.hostname.toLowerCase();
    let pageHost = "";
    try {
      pageHost = new URL(pageUrl).hostname.toLowerCase();
    } catch {}
    if (host === pageHost) return true;
    return (mod.connects ?? []).some((c) => {
      if (c === "*") return true;
      if (c === "self") return host === pageHost;
      if (c === "localhost") return ["localhost", "127.0.0.1", "[::1]"].includes(host);
      const d = c.replace(/^\*\./, "");
      return host === d || host.endsWith("." + d);
    });
  }

  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const toBase64 = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  function decodeBody(body, headers) {
    if (!body) return undefined;
    if (body.type && !headers.has("content-type")) headers.set("content-type", body.type);
    if (body.text != null) return body.text;
    if (body.base64 != null) return fromBase64(body.base64);
    if (body.form) {
      const form = new FormData();
      for (const [k, v] of body.form) {
        if (typeof v === "string") form.append(k, v);
        else form.append(k, new Blob([fromBase64(v.base64)], { type: v.type }), v.name);
      }
      return form;
    }
    return undefined;
  }

  /** chrome.runtime.onUserScriptConnect, for "gm-xhr" ports: one request each. */
  function onConnect(port) {
    if (port.name !== "gm-xhr") return;
    const controller = new AbortController();
    let timedOut = false;
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener(async (msg) => {
      if (msg.abort) return controller.abort();
      const post = (m) => {
        try {
          port.postMessage(m);
        } catch {}
      };
      try {
        await modsLoaded;
        const mod = getMod(msg.mod);
        if (!mod || mod.token !== msg.token) throw new Error(`mod ${msg.mod} isn't running`);
        if (!mod.grants?.includes("xmlhttpRequest")) throw new Error("needs @grant GM_xmlhttpRequest");
        const req = msg.request;
        const url = new URL(req.url);
        if (!/^https?:$/.test(url.protocol)) throw new Error(`only http and https URLs, not ${url.protocol}`);
        if (!connectAllowed(mod, url, port.sender?.url)) throw new Error(`blocked: add "// @connect ${url.hostname}" to the script's header`);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers ?? {})) {
          try {
            headers.set(k, String(v));
          } catch {}
        }
        const body = ["GET", "HEAD"].includes(req.method) ? undefined : decodeBody(req.body, headers);
        const timer = req.timeout > 0 ? setTimeout(() => ((timedOut = true), controller.abort()), req.timeout) : null;
        const res = await fetch(url, {
          method: req.method,
          headers,
          body,
          credentials: req.anonymous ? "omit" : "include",
          redirect: req.redirect === "manual" || req.redirect === "error" ? req.redirect : "follow",
          cache: req.nocache ? "no-store" : "default",
          signal: controller.signal,
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        clearTimeout(timer);
        const mimeType = res.headers.get("content-type") ?? "";
        const charset = /charset=([^;]+)/i.exec(mimeType)?.[1]?.trim();
        let text;
        if (!req.binary) {
          try {
            text = new TextDecoder(charset || "utf-8").decode(bytes);
          } catch {
            text = new TextDecoder().decode(bytes);
          }
        }
        post({
          type: "load",
          status: res.status,
          statusText: res.statusText,
          headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\r\n"),
          finalUrl: res.url,
          mimeType,
          ...(req.binary ? { base64: toBase64(bytes) } : { text }),
        });
      } catch (e) {
        post(timedOut ? { type: "timeout" } : { type: "error", error: String(e?.message ?? e) });
      }
    });
  }

  return { setMods, onMessage, onConnect, menusFor, runMenu, navigationStarted, pruneMenus, forgetTab, forget };
}
