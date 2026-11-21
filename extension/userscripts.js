// Mods → user scripts. Agent Bridge parses each .user.js / .user.css file
// (agent-bridge/src/modfile.ts) and sends the result; this turns it into the
// code chrome.userScripts registers. Functions whose source is injected into
// pages (gmRuntime, ruleMatches) must not reference anything outside
// themselves.

import { ruleMatches } from "./match.js";

export const styleId = (modId) => `eyepatch-${modId}`;

/** Returns early from the injected code if the page isn't one the mod's filter allows. */
function filterGuard(mod) {
  if (!mod.filter) return "";
  return `const ruleMatches = ${ruleMatches};
  const filter = ${JSON.stringify(mod.filter)};
  if (!filter.any.some((r) => ruleMatches(r, location.href)) || filter.none.some((r) => ruleMatches(r, location.href))) return;`;
}

/**
 * A UserCSS mod's styles: the sections that apply to this page, in one
 * <style>. Re-running it updates the styles in place (hot swap), or removes
 * them when no section applies.
 */
export function cssCode(mod) {
  return `(() => {
  const ruleMatches = ${ruleMatches};
  const sections = ${JSON.stringify(mod.sections ?? [])};
  const href = location.href;
  const css = sections.filter((s) => !s.rules.length || s.rules.some((r) => ruleMatches(r, href))).map((s) => s.css).join("\\n");
  const id = ${JSON.stringify(styleId(mod.id))};
  let s = document.getElementById(id);
  if (!css) return s?.remove();
  if (!s) {
    s = document.createElement("style");
    s.id = id;
    (document.head || document.documentElement).appendChild(s);
  }
  s.textContent = css;
})();`;
}

export function removeCssCode(modId) {
  return `document.getElementById(${JSON.stringify(styleId(modId))})?.remove();`;
}

/** Tells the extension the mod ran in this page, for the toolbar badge. */
export function reportCode(mod) {
  return `(() => {
  ${filterGuard(mod)}
  const report = () => chrome.runtime.sendMessage({ type: "mod_ran", id: ${JSON.stringify(mod.id)} }).catch(() => {});
  report();
  addEventListener("pageshow", (e) => e.persisted && report()); // back/forward cache
})();`;
}

/** The names a userscript's code sees as locals (its GM API). */
const GM_NAMES = [
  "GM", "GM_info", "unsafeWindow",
  "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_getValues", "GM_setValues", "GM_deleteValues",
  "GM_addValueChangeListener", "GM_removeValueChangeListener",
  "GM_addStyle", "GM_addElement", "GM_getResourceText", "GM_getResourceURL",
  "GM_xmlhttpRequest", "GM_openInTab", "GM_notification", "GM_setClipboard",
  "GM_registerMenuCommand", "GM_unregisterMenuCommand", "GM_log",
];

/**
 * A userscript, run the way userscript managers run them: inside a function
 * whose parameters are its GM API, after its @require files.
 */
export function jsCode(mod, version, token) {
  const granted = mod.info?.script?.grant ?? [];
  // Granted but unsupported GM_ functions become stubs that say so.
  const stubs = granted.filter((g) => /^GM_\w+$/.test(g) && !GM_NAMES.includes(g));
  const names = [...GM_NAMES, ...new Set(stubs)];
  const cfg = {
    id: mod.id,
    token,
    name: mod.name,
    world: mod.world,
    grants: mod.grants ?? [],
    granted: granted.filter((g) => /^GM[._]\w+$/.test(g)),
    resources: mod.resources ?? {},
    filter: mod.filter ?? null,
    info: { ...(mod.info ?? {}), version },
  };
  return `(${gmRuntime})(${ruleMatches}, ${JSON.stringify(cfg)}, ${JSON.stringify(names)}, function (${names.join(", ")}) {
${(mod.requires ?? []).join("\n;\n")}
${mod.js ?? ""}
});`;
}

/** `token` is the mod's GM API token (see gm.js), built into its code. */
export function scriptsFor(mod, version, token) {
  if (mod.error || !mod.enabled) return [];
  const common = { matches: mod.matches, excludeMatches: mod.excludeMatches ?? [] };
  const out = [{ ...common, id: `mod:${mod.id}:ran`, js: [{ code: reportCode(mod) }], runAt: "document_start", world: "USER_SCRIPT" }];
  if (mod.kind === "css") {
    out.push({ ...common, id: `mod:${mod.id}:css`, js: [{ code: cssCode(mod) }], runAt: "document_start", world: "USER_SCRIPT", allFrames: mod.allFrames });
  } else {
    const world = mod.world === "main" ? "MAIN" : "USER_SCRIPT";
    out.push({ ...common, id: `mod:${mod.id}:js`, js: [{ code: jsCode(mod, version, token) }], runAt: mod.runAt, world, allFrames: mod.allFrames });
  }
  return out;
}

/**
 * Runs in the page: builds a userscript's GM API and calls its code with it.
 * In the isolated USER_SCRIPT world the API reaches the extension through
 * chrome.runtime messaging (see gm.js); in the page's own world only the
 * functions that need nothing from the extension work.
 */
export function gmRuntime(ruleMatches, cfg, names, body) {
  const href = location.href;
  if (cfg.filter && (!cfg.filter.any.some((r) => ruleMatches(r, href)) || cfg.filter.none.some((r) => ruleMatches(r, href)))) return;

  const tag = `[mod ${cfg.id}]`;
  const isolated = cfg.world !== "main" && typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
  const grants = new Set(cfg.grants);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const logError = (e) => console.error(tag, e);
  /** Records an exception with the mod's id, for get_console_logs. */
  const report = (e) => {
    (globalThis.__smConsole ||= []).push({ t: Date.now(), world: cfg.world === "main" ? "page" : "mods", level: "uncaught", text: `${tag} ${e?.stack || e}` });
  };
  const call = (method, ...args) => {
    if (!isolated) return Promise.reject(new Error(`${method} isn't available to scripts that run in the page (@inject-into page)`));
    return chrome.runtime.sendMessage({ type: "gm", mod: cfg.id, token: cfg.token, method, args }).then((r) => {
      if (r?.error) throw new Error(r.error);
      return r?.result;
    });
  };
  const toBase64 = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // ---- storage: a copy of the values, kept in sync with the extension ----
  let values = {};
  const listeners = new Map();
  let listenerSeq = 0;
  const STORAGE = ["getValue", "setValue", "deleteValue", "listValues", "getValues", "setValues", "deleteValues", "addValueChangeListener"];
  const usesStorage = STORAGE.some((g) => grants.has(g));
  const loaded = usesStorage && isolated ? call("values").then((v) => (values = v || {}), logError) : Promise.resolve();
  const changed = (key, oldValue, newValue, remote) => {
    for (const l of listeners.values()) {
      if (l.key !== key) continue;
      try {
        l.cb(key, oldValue, newValue, remote);
      } catch (e) {
        logError(e);
      }
    }
  };
  const getValue = (key, def) => (Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : def);
  const setValue = (key, value) => {
    const old = values[key];
    if (value === undefined) return deleteValue(key);
    values[key] = clone(value);
    call("set", key, values[key]).catch(logError);
    changed(key, clone(old), clone(value), false);
  };
  const deleteValue = (key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return;
    const old = values[key];
    delete values[key];
    call("delete", key).catch(logError);
    changed(key, clone(old), undefined, false);
  };
  const listValues = () => Object.keys(values);
  const getValues = (keys) => {
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, clone(values[k])]));
    return Object.fromEntries(Object.entries(keys ?? {}).map(([k, d]) => [k, getValue(k, d)]));
  };
  const setValues = (obj) => Object.entries(obj ?? {}).forEach(([k, v]) => setValue(k, v));
  const deleteValues = (keys) => (keys ?? []).forEach(deleteValue);
  const addValueChangeListener = (key, cb) => {
    const id = ++listenerSeq;
    listeners.set(id, { key, cb });
    return id;
  };
  const removeValueChangeListener = (id) => listeners.delete(id);

  // ---- menu commands, shown in the side panel's menu ----
  const menu = new Map();
  let menuSeq = 0;
  const registerMenuCommand = (caption, fn, opts) => {
    const id = String((opts && typeof opts === "object" && opts.id) || `c${++menuSeq}`);
    menu.set(id, fn);
    call("menuRegister", id, String(caption)).catch(logError);
    return id;
  };
  const unregisterMenuCommand = (id) => {
    menu.delete(String(id));
    call("menuUnregister", String(id)).catch(logError);
  };

  // The extension reaches this script through a registry in the isolated
  // world's globals (never on the page's window).
  if (isolated) {
    const reg = (globalThis.__eyepatchGM ||= { mods: new Map() });
    reg.mods.set(cfg.id, {
      value(key, value, deleted) {
        const had = Object.prototype.hasOwnProperty.call(values, key);
        if (deleted ? !had : had && JSON.stringify(values[key]) === JSON.stringify(value)) return;
        const old = values[key];
        if (deleted) delete values[key];
        else values[key] = value;
        changed(key, clone(old), clone(value), true);
      },
      menu(id) {
        try {
          menu.get(id)?.();
        } catch (e) {
          logError(e);
        }
      },
    });
  }

  // ---- the DOM ----
  const addStyle = (css) => {
    const s = document.createElement("style");
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  };
  const addElement = (...args) => {
    const parent = typeof args[0] === "string" ? null : args.shift();
    const [tagName, attrs] = args;
    const el = document.createElement(tagName);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (k === "textContent") el.textContent = v;
      else el.setAttribute(k, v);
    }
    (parent || document.head || document.documentElement).appendChild(el);
    return el;
  };
  const getResourceText = (name) => {
    const r = cfg.resources[name];
    return r ? new TextDecoder().decode(fromBase64(r.base64)) : null;
  };
  const getResourceURL = (name) => {
    const r = cfg.resources[name];
    return r ? `data:${r.mimeType};base64,${r.base64}` : null;
  };
  const setClipboard = (data, info) => {
    const text = String(data);
    const html = info === "html" || info?.type === "html" || info?.mimetype === "text/html";
    const fallback = () => {
      const t = document.createElement("textarea");
      t.value = text;
      t.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.documentElement.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    };
    const write = html
      ? navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([text], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })])
      : navigator.clipboard.writeText(text);
    return write.catch(fallback);
  };

  // ---- the extension: tabs and notifications ----
  const openInTab = (url, opts) => {
    const active = typeof opts === "boolean" ? !opts : opts?.active ?? (opts?.loadInBackground != null ? !opts.loadInBackground : true);
    const tab = call("openInTab", new URL(url, location.href).href, active);
    const handle = {
      closed: false,
      onclose: null,
      close() {
        handle.closed = true;
        tab.then((id) => call("closeTab", id)).catch(logError);
      },
    };
    tab.catch(logError);
    return handle;
  };
  const notification = (details, ...rest) => {
    const d = typeof details === "string" ? { text: details, title: rest[0], image: rest[1] } : details ?? {};
    return call("notification", { title: d.title, text: d.text, image: d.image }).catch(logError);
  };

  // ---- cross-origin requests ----
  const encodeBody = async (data) => {
    if (data == null) return null;
    if (typeof data === "string") return { text: data };
    if (data instanceof URLSearchParams) return { text: data.toString(), type: "application/x-www-form-urlencoded;charset=UTF-8" };
    if (data instanceof Blob) return { base64: toBase64(new Uint8Array(await data.arrayBuffer())), type: data.type };
    if (data instanceof ArrayBuffer) return { base64: toBase64(new Uint8Array(data)) };
    if (ArrayBuffer.isView(data)) return { base64: toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
    if (data instanceof FormData) {
      const form = [];
      for (const [k, v] of data) {
        form.push(typeof v === "string" ? [k, v] : [k, { name: v.name, type: v.type, base64: toBase64(new Uint8Array(await v.arrayBuffer())) }]);
      }
      return { form };
    }
    return { text: typeof data === "object" ? JSON.stringify(data) : String(data) };
  };
  const xmlhttpRequest = (details) => {
    const responseType = String(details.responseType || "").toLowerCase();
    const port = chrome.runtime.connect({ name: "gm-xhr" });
    let done = false;
    const respond = (m) => {
      const bytes = m.base64 != null ? fromBase64(m.base64) : null;
      const text = m.text ?? null;
      let response = text;
      if (responseType === "json") {
        try {
          response = JSON.parse(text);
        } catch {
          response = undefined;
        }
      } else if (responseType === "arraybuffer") response = bytes.buffer;
      else if (responseType === "blob") response = new Blob([bytes], { type: m.mimeType });
      else if (responseType === "document") response = new DOMParser().parseFromString(text, /xml/.test(m.mimeType) ? "text/xml" : "text/html");
      return {
        readyState: 4,
        status: m.status,
        statusText: m.statusText,
        responseHeaders: m.headers,
        finalUrl: m.finalUrl,
        response,
        get responseText() {
          return text ?? (bytes ? new TextDecoder().decode(bytes) : "");
        },
        get responseXML() {
          return text != null && /xml|html/.test(m.mimeType) ? new DOMParser().parseFromString(text, /xml/.test(m.mimeType) ? "text/xml" : "text/html") : null;
        },
        context: details.context,
      };
    };
    const failure = (error) => ({ readyState: 4, status: 0, statusText: "", responseHeaders: "", response: null, responseText: "", finalUrl: details.url, error, context: details.context });
    const finish = (kind, res) => {
      if (done) return;
      done = true;
      try {
        if (kind === "load") {
          details.onreadystatechange?.(res);
          details.onload?.(res);
        } else details[`on${kind}`]?.(res);
        details.onloadend?.(res);
      } catch (e) {
        logError(e);
      } finally {
        port.disconnect();
      }
    };
    port.onMessage.addListener((m) => {
      if (m.type === "load") finish("load", respond(m));
      else if (m.type === "timeout") finish("timeout", failure("timeout"));
      else {
        console.warn(tag, `GM_xmlhttpRequest ${details.url}: ${m.error}`);
        finish("error", failure(m.error));
      }
    });
    port.onDisconnect.addListener(() => finish("error", failure("disconnected")));
    encodeBody(details.data).then(
      (body) =>
        !done &&
        port.postMessage({
          mod: cfg.id,
          token: cfg.token,
          request: {
            url: new URL(details.url, location.href).href,
            method: String(details.method || "GET").toUpperCase(),
            headers: details.headers ?? {},
            body,
            binary: responseType === "arraybuffer" || responseType === "blob",
            timeout: details.timeout || 0,
            anonymous: Boolean(details.anonymous),
            redirect: details.redirect,
            nocache: Boolean(details.nocache),
          },
        }),
      (e) => finish("error", failure(String(e))),
    );
    details.onloadstart?.({ readyState: 1, context: details.context });
    return {
      abort() {
        if (done) return;
        port.postMessage({ abort: true });
        finish("abort", failure("aborted"));
      },
    };
  };
  const xmlHttpRequestPromise = (details) => {
    let handle;
    const p = new Promise((resolve, reject) => {
      handle = xmlhttpRequest({
        ...details,
        onload: (r) => (details.onload?.(r), resolve(r)),
        onerror: (r) => (details.onerror?.(r), reject(r)),
        ontimeout: (r) => (details.ontimeout?.(r), reject(r)),
        onabort: (r) => (details.onabort?.(r), reject(r)),
      });
    });
    p.abort = () => handle.abort();
    return p;
  };

  // ---- the API, limited to what the script @grants ----
  const info = cfg.info;
  const fns = {
    getValue, setValue, deleteValue, listValues, getValues, setValues, deleteValues,
    addValueChangeListener, removeValueChangeListener,
    addStyle, addElement, getResourceText, getResourceURL,
    xmlhttpRequest, openInTab, notification, setClipboard,
    registerMenuCommand, unregisterMenuCommand,
    log: (...a) => console.log(...a),
  };
  const asyncNames = { xmlhttpRequest: "xmlHttpRequest", getResourceURL: "getResourceUrl" };
  const api = { GM_info: info, unsafeWindow: window };
  const GM = { info };
  for (const [name, fn] of Object.entries(fns)) {
    if (!grants.has(name)) continue;
    api[`GM_${name}`] = fn;
    GM[asyncNames[name] ?? name] = name === "xmlhttpRequest" ? xmlHttpRequestPromise : async (...a) => (await loaded, fn(...a));
  }
  // Granted functions Eyepatch doesn't have throw a clear error instead of being undefined.
  for (const g of cfg.granted) {
    const name = g.slice(3);
    const stub = () => {
      throw new Error(`${g} isn't supported in Eyepatch`);
    };
    if (g.startsWith("GM_") && !(g in api)) api[g] = stub;
    if (g.startsWith("GM.") && !(name in GM) && !(name in asyncNames)) GM[name] = async () => stub();
  }
  api.GM = GM;

  const run = () => {
    try {
      body.apply(window, names.map((n) => api[n]));
    } catch (e) {
      report(e);
      throw e;
    }
  };
  // Synchronous GM_getValue needs the values before the script starts.
  if (usesStorage && isolated) loaded.then(run);
  else run();
}
