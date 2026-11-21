import { modApplies } from "./match.js";
import { fillIcons, icon, mark } from "./icons.js";
import { codeBlock, esc, inline, markdown } from "./markdown.js";
import { browserTool, toolTitle } from "./tool-names.js";

const params = new URLSearchParams(location.search);
// ?demo opens a canned chat (every Markdown element, tools, permissions)
// without Chrome or Agent Bridge, e.g. served from extension/ over HTTP.
const DEMO = params.has("demo");
const demo = DEMO ? await import("./demo-chat.js") : null;

fillIcons();
// Focus rings are for keyboard use; Chrome also shows them after some clicks.
addEventListener("pointerdown", () => document.body.classList.add("pointer"), true);
addEventListener("keydown", (e) => e.key === "Tab" && document.body.classList.remove("pointer"), true);

const $ = (id) => document.getElementById(id);
// Each tab has its own side panel and chat; this is the tab this panel belongs to.
const TAB_ID = Number(params.get("tab"));
const thread = $("thread");
const input = $("input");

let state = null;
let port = null;
let history = null; // past chats, newest first; fetched when the menu opens
let hasMessages = false;
let openMenu = null; // "agent" | "more" | "model"
let attachments = []; // images for the next message: { mimeType, data, thumb }
let picked = []; // elements picked on the page for the next message: { selector, label, html, text }
let picking = false;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// ---------- connection to the service worker ----------

function connectPort() {
  port = DEMO ? demo.connect() : chrome.runtime.connect({ name: `sidepanel:${TAB_ID}` });
  port.onMessage.addListener((msg) => {
    if (msg.type === "init") {
      resetThread();
      for (const e of msg.transcript) render(e, { replay: true });
      setState(msg.state);
    } else if (msg.type === "state") {
      setState(msg.state);
    } else if (msg.type === "event") {
      render(msg.event);
    } else if (msg.type === "picked") {
      onPicked(msg.element);
    } else if (msg.type === "history") {
      history = msg.items;
      renderMoreMenu();
      renderAllChats();
    }
  });
  // The service worker can restart (e.g. extension reload); reconnect.
  port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
  reportVisibility();
}

// Lets the background skip notifications while the user is watching the panel,
// and pick a toolbar icon that shows on Chrome's light or dark toolbar.
function reportVisibility() {
  port?.postMessage({ type: "visibility", visible: document.visibilityState === "visible" });
}
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const reportScheme = () => port?.postMessage({ type: "color_scheme", dark: darkQuery.matches });
document.addEventListener("visibilitychange", reportVisibility);
darkQuery.addEventListener("change", reportScheme);
connectPort();
reportScheme();

const openTab = (url) => (DEMO ? console.log("open", url) : chrome.tabs.create({ url }));
/** Agents are installed and authenticated in Settings. */
const openSettings = (hash = "") => openTab(DEMO ? `options.html${hash}` : chrome.runtime.getURL(`options.html${hash}`));

// ---------- state: header, alerts, message box ----------

const currentAgent = () => state?.agents?.list.find((a) => a.id === state.agents.selected) ?? null;
const needsAuth = (s) => s?.auth?.state === "unauthenticated";

function agentLogo(agent) {
  return agent?.icon ? `<img class="agent-logo" src="${esc(agent.icon)}" alt="" />` : icon("code");
}

function setState(s) {
  state = s;
  const c = s.bridge;
  const agent = currentAgent();
  const hasAgent = c.connected && !c.needsAgent && Boolean(c.agent || agent);

  $("agent").hidden = !hasAgent;
  if (hasAgent) {
    $("agent").innerHTML = `${agentLogo(agent)}<span class="agent-name">${esc(c.agent ?? agent.name)}</span>${icon("chevron-down", { size: 14, cls: "chevron" })}`;
    $("agent").setAttribute("aria-label", `Agent: ${c.agent ?? agent.name}. Switch agent`);
  }
  $("new").hidden = !hasAgent;
  document.body.classList.toggle("no-agent", c.connected && c.needsAgent);

  $("send").hidden = c.busy;
  $("stop").hidden = !c.busy;
  $("send").disabled = !hasAgent || !c.ready || needsAuth(s);
  input.disabled = c.connected && c.needsAgent;
  $("attach").hidden = !c.images;
  renderTarget();

  renderAlerts();
  renderModel();
  renderAgentMenu();
  renderMoreMenu();
  renderEmpty();
  renderStatus();
}

function renderAlerts() {
  const s = state;
  const c = s.bridge;
  const alerts = [];
  const alert = (text, action = "") =>
    `<div class="alert" role="alert">${icon("circle-alert")}<div class="body"><span>${text}</span>${action}</div></div>`;
  if (!c.connected) {
    alerts.push(alert(`Can’t reach Agent Bridge.`, `<button type="button" class="btn outline" data-action="bridge-help">How to start it ${icon("square-arrow-out-up-right", { size: 15 })}</button>`));
  }
  if (c.connected && !c.needsAgent && needsAuth(s)) {
    alerts.push(alert(`${esc(s.auth.agent)} needs to authenticate.`, `<button type="button" class="btn primary" data-action="authenticate">Authenticate</button>`));
  }
  if (!s.userScripts) {
    alerts.push(
      alert(
        `Turn on <b>Allow User Scripts</b> so mods can run.`,
        `<button type="button" class="btn outline" data-action="user-scripts">Open extension settings ${icon("square-arrow-out-up-right", { size: 15 })}</button>`,
      ),
    );
  }
  for (const [id, err] of Object.entries(s.modErrors ?? {})) {
    const name = s.mods?.find((m) => m.id === id)?.name ?? id;
    alerts.push(alert(`<span><b>${esc(name)}</b> isn’t running: ${esc(err)}</span>`));
  }
  const html = alerts.join("");
  if ($("alerts").dataset.html !== html) $("alerts").innerHTML = $("alerts").dataset.html = html;
}

$("alerts").addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "user-scripts") openTab(`chrome://extensions/?id=${DEMO ? "" : chrome.runtime.id}`);
  if (action === "authenticate") openSettings(`#signin=${encodeURIComponent(state.bridge.agentId)}`);
  if (action === "bridge-help") openSettings();
});

// The page the message is about.
let tab = { url: "", title: "" };
async function updatePage() {
  tab = DEMO ? demo.tab : ((await chrome.tabs.get(TAB_ID).catch(() => null)) ?? { url: "", title: "" });
  const host = hostOf(tab.url);
  const label = host.length > 24 ? host.slice(0, 23) + "…" : host;
  $("page").hidden = !host;
  $("page").querySelector("span").textContent = label;
  $("page").title = [tab.title, tab.url].filter(Boolean).join("\n");
  renderMoreMenu();
  renderTarget();
}
if (!DEMO) chrome.tabs.onUpdated.addListener((id, info) => id === TAB_ID && (info.url || info.title) && updatePage());
updatePage();

// ---------- message box ----------

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + "px";
}
input.addEventListener("input", autosize);

function submit(text = input.value.trim()) {
  const images = state?.bridge.images ? attachments : [];
  if ((!text && !images.length) || !state?.bridge.ready || state.bridge.busy || needsAuth(state)) return;
  port.postMessage({ type: "prompt", text, images: images.length ? images : undefined, elements: picked.length ? picked : undefined });
  input.value = "";
  attachments = [];
  picked = [];
  renderAttachments();
  autosize();
}
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
$("stop").addEventListener("click", () => port.postMessage({ type: "cancel" }));
$("new").addEventListener("click", () => port.postMessage({ type: "new_session" }));

// ---------- images ----------

const MAX_IMAGES = 6;
const MAX_EDGE = 1568; // the model API downscales anything larger
const THUMB_EDGE = 160;

/** Scale an image down to fit `edge` and encode it. JPEG on white for photos and thumbnails, PNG otherwise. */
function encode(bmp, edge, type) {
  const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d");
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, 0.88);
}

async function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/") || attachments.length >= MAX_IMAGES) continue;
    try {
      const bmp = await createImageBitmap(file);
      const mimeType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
      const full = encode(bmp, MAX_EDGE, mimeType);
      attachments.push({ mimeType, data: full.slice(full.indexOf(",") + 1), thumb: encode(bmp, THUMB_EDGE, "image/jpeg") });
    } catch (e) {
      console.warn("[eyepatch] couldn't read image:", e);
    }
  }
  renderAttachments();
}

/** Images and picked elements waiting to go with the next message. */
function renderAttachments() {
  const el = $("attachments");
  el.hidden = !attachments.length && !picked.length;
  el.innerHTML =
    attachments
      .map((a, i) => `<div class="attachment"><img src="${a.thumb}" alt="Image ${i + 1}" /><button type="button" class="remove" data-remove="${i}" aria-label="Remove image ${i + 1}">${icon("x", { size: 12, stroke: 2.5 })}</button></div>`)
      .join("") +
    picked
      .map(
        (p, i) =>
          `<span class="pill" title="${esc(p.selector)}">${icon("square-dashed-mouse-pointer", { size: 14 })}<span>${esc(p.label)}</span>` +
          `<button type="button" class="icon-btn remove-el" data-remove-el="${i}" aria-label="Remove ${esc(p.label)}">${icon("x", { size: 13 })}</button></span>`,
      )
      .join("");
}
$("attachments").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove], [data-remove-el]");
  if (!b) return;
  if (b.dataset.remove != null) attachments.splice(Number(b.dataset.remove), 1);
  else picked.splice(Number(b.dataset.removeEl), 1);
  renderAttachments();
  input.focus();
});

$("attach").addEventListener("click", () => $("files").click());

// ---------- picking an element on the page ----------

function pickable() {
  return /^(https?|file):/.test(tab.url ?? "") && Boolean(state?.bridge.connected);
}

function renderTarget() {
  $("target").hidden = !pickable();
  $("target").setAttribute("aria-pressed", String(picking));
}
$("target").addEventListener("click", () => {
  picking = !picking;
  port.postMessage({ type: picking ? "pick_element" : "pick_cancel" });
  renderTarget();
});
function onPicked(element) {
  picking = false;
  renderTarget();
  if (element?.selector && !picked.some((p) => p.selector === element.selector)) picked.push(element);
  renderAttachments();
  input.focus();
}
$("files").addEventListener("change", () => {
  void addImages([...$("files").files]);
  $("files").value = "";
  input.focus();
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length || !state?.bridge.images) return;
  e.preventDefault();
  void addImages(files);
});
// Drop images anywhere on the panel.
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragover", (e) => {
  if (!hasFiles(e) || !state?.bridge.images) return;
  e.preventDefault();
  $("composer").classList.add("dropping");
});
document.addEventListener("dragleave", (e) => !e.relatedTarget && $("composer").classList.remove("dropping"));
document.addEventListener("drop", (e) => {
  $("composer").classList.remove("dropping");
  if (!hasFiles(e) || !state?.bridge.images) return;
  e.preventDefault();
  void addImages([...e.dataTransfer.files]);
});

// ---------- menus (agent switcher, more, model) ----------

function setMenu(name) {
  if (name === "more" && openMenu !== "more") port.postMessage({ type: "history_list" });
  openMenu = name;
  renderAgentMenu();
  renderMoreMenu();
  renderModelMenu();
}
for (const [btn, name] of [["agent", "agent"], ["more", "more"], ["model", "model"]]) {
  $(btn).addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(openMenu === name ? null : name);
  });
}
document.addEventListener("click", (e) => openMenu && !e.target.closest(".menu") && setMenu(null));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (openMenu) setMenu(null);
  else if (!$("all-chats").hidden) showAllChats(false);
});

function renderAgentMenu() {
  const el = $("agent-menu");
  const agents = state?.agents;
  const open = openMenu === "agent" && Boolean(agents) && !$("agent").hidden;
  el.hidden = !open;
  $("agent").setAttribute("aria-expanded", String(open));
  if (!open) return;
  const installed = agents.list.filter((a) => a.installedVersion || a.id === agents.selected);
  const tile = (a) => (a.icon ? `<span class="tile sm"><img class="agent-logo" src="${esc(a.icon)}" alt="" /></span>` : `<span class="tile sm">${esc(a.name[0] ?? "?")}</span>`);
  el.innerHTML =
    `<div class="menu-group">` +
    installed
      .map(
        (a) =>
          `<button type="button" class="menu-item" role="menuitem" data-agent="${esc(a.id)}">${tile(a)}<span class="grow">${esc(a.name)}</span>` +
          (a.id === agents.selected ? icon("check", { cls: "check", label: "Current agent" }) : "") +
          `</button>`,
      )
      .join("") +
    `<button type="button" class="menu-item" role="menuitem" data-action="add"><span class="tile sm">${icon("plus", { size: 15 })}</span><span class="grow">Add more agents</span></button></div>`;
}
$("agent-menu").addEventListener("click", (e) => {
  const t = e.target.closest("[data-agent], [data-action]");
  if (!t) return;
  setMenu(null);
  if (t.dataset.action === "add") return openSettings();
  const id = t.dataset.agent;
  port.postMessage(id === state.agents.selected ? { type: "new_session" } : { type: "agent_select", id });
});

const RECENT = 15;

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const otherChats = () => (history ?? []).filter((c) => c.sessionId !== state?.sessionId);
const chatItem = (c) =>
  `<button type="button" class="menu-item" role="menuitem" data-session="${esc(c.sessionId)}" title="${esc([c.agent, hostOf(c.url)].filter(Boolean).join(" · "))}">` +
  `<span class="grow">${esc(c.title || "Untitled")}</span><span class="meta">${esc(ago(c.updatedAt))}</span></button>`;

function renderMoreMenu() {
  const el = $("more-menu");
  const open = openMenu === "more";
  el.hidden = !open;
  $("more").setAttribute("aria-expanded", String(open));
  if (!open) return;
  let html = `<div class="menu-group"><button type="button" class="menu-item" role="menuitem" data-action="settings">${icon("settings")}<span class="grow">Settings</span></button></div>`;
  const mods = (state?.mods ?? []).filter((m) => !m.error && tab.url && modApplies(m, tab.url));
  if (mods.length) {
    html +=
      `<div class="menu-group" role="group" aria-label="Mods on this page"><p class="menu-label">Mods on this page</p>` +
      mods
        .map(
          (m) =>
            `<div class="menu-item${m.enabled ? "" : " off"}" title="${esc(m.description ?? "")}"><span class="grow">${esc(m.name)}</span>` +
            `<button type="button" class="switch" role="switch" aria-checked="${m.enabled}" aria-label="${esc(m.name)}" data-mod="${esc(m.id)}"></button></div>` +
            // The mod's own commands (GM_registerMenuCommand).
            (m.enabled ? (state.menuCommands ?? []) : [])
              .filter((c) => c.modId === m.id)
              .map((c) => `<button type="button" class="menu-item command" role="menuitem" data-command="${esc(c.id)}" data-command-mod="${esc(m.id)}"><span class="grow">${esc(c.caption)}</span></button>`)
              .join(""),
        )
        .join("") +
      `</div>`;
  }
  const chats = otherChats();
  if (chats.length) {
    // This site's chats first, then the rest; newest first within each.
    const here = hostOf(tab.url);
    const recent = [...chats].sort((a, b) => (hostOf(b.url) === here) - (hostOf(a.url) === here)).slice(0, RECENT);
    html += `<div class="menu-group" role="group" aria-label="Recent chats"><p class="menu-label">Recent chats</p>${recent.map(chatItem).join("")}`;
    if (chats.length > recent.length) html += `<button type="button" class="menu-item" role="menuitem" data-action="all"><span class="grow">All chats</span>${icon("chevron-right", { size: 14 })}</button>`;
    html += `</div>`;
  }
  el.innerHTML = html;
}

$("more-menu").addEventListener("click", (e) => {
  const sw = e.target.closest("[data-mod]");
  if (sw) {
    const enabled = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(enabled));
    sw.closest(".menu-item").classList.toggle("off", !enabled);
    port.postMessage({ type: "mod_set_enabled", id: sw.dataset.mod, enabled });
    return;
  }
  const cmd = e.target.closest("[data-command]");
  if (cmd) {
    setMenu(null);
    port.postMessage({ type: "menu_command", modId: cmd.dataset.commandMod, id: cmd.dataset.command });
    return;
  }
  const t = e.target.closest("[data-action], [data-session]");
  if (!t) return;
  setMenu(null);
  if (t.dataset.session) port.postMessage({ type: "history_restore", sessionId: t.dataset.session });
  else if (t.dataset.action === "all") showAllChats(true);
  else if (t.dataset.action === "settings") openSettings();
});

// ---------- all chats ----------

function showAllChats(show) {
  $("all-chats").hidden = !show;
  $("panel").inert = show;
  if (show) {
    $("all-filter").value = "";
    renderAllChats();
    $("all-filter").focus();
  }
}
$("all-back").addEventListener("click", () => showAllChats(false));
$("all-filter").addEventListener("input", renderAllChats);

function renderAllChats() {
  if ($("all-chats").hidden) return;
  const q = $("all-filter").value.trim().toLowerCase();
  const chats = otherChats().filter((c) => !q || `${c.title} ${c.url}`.toLowerCase().includes(q));
  // Grouped by site: this site first, then by most recent activity.
  const groups = new Map();
  const here = hostOf(tab.url);
  if (chats.some((c) => hostOf(c.url) === here)) groups.set(here, []);
  for (const c of chats) {
    const site = hostOf(c.url) || "Other";
    if (!groups.has(site)) groups.set(site, []);
    groups.get(site).push(c);
  }
  $("all-list").innerHTML = [...groups]
    .filter(([, list]) => list.length)
    .map(([site, list]) => `<div class="menu-group" role="group" aria-label="${esc(site)}"><p class="menu-label">${esc(site)}</p>${list.map(chatItem).join("")}</div>`)
    .join("");
}
$("all-list").addEventListener("click", (e) => {
  const t = e.target.closest("[data-session]");
  if (!t) return;
  showAllChats(false);
  port.postMessage({ type: "history_restore", sessionId: t.dataset.session });
});

// ---------- model and effort ----------
// One menu: the models, then an "Effort" row that opens the effort levels in
// place (the panel is too narrow for a submenu beside it).

// Agents name effort levels plainly ("Xhigh"); spell that one out.
const optionName = (o) => (o.name === "Xhigh" ? "Extra high" : o.name);
const currentOf = (pick) => pick?.options.find((o) => o.value === pick.current) ?? null;
let modelView = "models"; // or "effort"

function renderModel() {
  const el = $("model");
  const { model, effort } = state ?? {};
  el.hidden = !model?.options.length && !effort?.options.length;
  if (el.hidden) return;
  const m = currentOf(model);
  const e = currentOf(effort);
  const parts = [m && esc(m.name), e && `<span class="effort-label">${esc(optionName(e))}</span>`].filter(Boolean);
  el.innerHTML = `<span>${parts.join(" ") || "Model"}</span>${icon("chevron-down", { size: 13 })}`;
  el.title = m?.description ?? "";
  el.setAttribute("aria-label", [m && `Model: ${m.name}`, e && `Effort: ${optionName(e)}`].filter(Boolean).join(", "));
  renderModelMenu();
}

function renderModelMenu() {
  const el = $("model-menu");
  const { model, effort } = state ?? {};
  const open = openMenu === "model" && !$("model").hidden;
  el.hidden = !open;
  $("model").setAttribute("aria-expanded", String(open));
  if (!open) return;
  if (!model?.options.length) modelView = "effort";
  if (!effort?.options.length) modelView = "models";
  const view = modelView;
  if (el.dataset.view !== view) {
    el.dataset.view = view;
    const filterable = view === "models" && model.options.length > 10;
    el.innerHTML =
      view === "models"
        ? `<div class="menu-group">` +
          (filterable ? `<label class="search">${icon("search", { size: 16 })}<input type="search" placeholder="Filter models" aria-label="Filter models" /></label>` : "") +
          `<div class="model-list"></div></div>` +
          (effort?.options.length ? `<div class="menu-group"><button type="button" class="menu-item" role="menuitem" data-action="effort"><span class="grow">Effort</span><span class="meta effort-current"></span>${icon("chevron-right", { size: 14 })}</button></div>` : "")
        : (model?.options.length ? `<button type="button" class="menu-item back" role="menuitem" data-action="back">${icon("chevron-left", { size: 14 })}<span class="grow">Effort</span></button>` : `<p class="menu-label">Effort</p>`) +
          `<div class="model-list"></div>`;
    el.querySelector("input")?.addEventListener("input", renderModelList);
    queueMicrotask(() => (el.querySelector("input") ?? el.querySelector(".menu-item"))?.focus());
  }
  renderModelList();
}

function renderModelList() {
  const el = $("model-menu");
  const pick = modelView === "models" ? state.model : state.effort;
  const q = el.querySelector("input")?.value.trim().toLowerCase() ?? "";
  el.querySelector(".model-list").innerHTML = pick.options
    .filter((o) => !q || o.name.toLowerCase().includes(q))
    .map(
      (o) =>
        `<button type="button" class="menu-item" role="menuitemradio" aria-checked="${o.value === pick.current}" data-value="${esc(o.value)}" title="${esc(o.description ?? "")}">` +
        `<span class="grow">${esc(optionName(o))}</span>${o.value === pick.current ? icon("check", { cls: "check" }) : ""}</button>`,
    )
    .join("");
  const current = el.querySelector(".effort-current");
  if (current) current.textContent = optionName(currentOf(state.effort) ?? { name: "" });
}

$("model-menu").addEventListener("click", (e) => {
  e.stopPropagation(); // the menu re-renders; keep the outside-click handler from closing it
  const t = e.target.closest("[data-value], [data-action]");
  if (!t) return;
  if (t.dataset.action) {
    modelView = t.dataset.action === "effort" ? "effort" : "models";
    return renderModelMenu();
  }
  port.postMessage({ type: modelView === "effort" ? "set_effort" : "set_model", value: t.dataset.value });
  setMenu(null);
});
new MutationObserver(() => {
  if (!$("model-menu").hidden) return;
  delete $("model-menu").dataset.view;
  modelView = "models";
}).observe($("model-menu"), { attributes: true, attributeFilter: ["hidden"] });

// ---------- empty chat ----------

const IDEAS = [
  ["eye-off", "Hide distractions on this page"],
  ["file-text", "Make the text easier to read"],
  ["moon", "Add a dark mode"],
];
$("chips").innerHTML = IDEAS.map(([i, text]) => `<button type="button" class="chip" role="listitem">${icon(i, { size: 15 })}<span>${esc(text)}</span></button>`).join("");
$("chips").addEventListener("click", (e) => {
  const t = e.target.closest(".chip");
  if (t) submit(t.textContent.trim());
});

function renderEmpty() {
  const noAgent = state?.bridge.connected && state.bridge.needsAgent;
  const empty = !hasMessages;
  let el = thread.querySelector(".empty");
  $("chips").hidden = !empty || noAgent || !state?.bridge.ready;
  if (!empty) return el?.remove();
  const html = noAgent
    ? `${mark({ size: 48 })}<h1>Install an agent to start</h1><button type="button" class="btn primary" data-action="settings">Open Settings</button>`
    : `${mark({ size: 48 })}<h1>What do you want to modify?</h1>`;
  if (!el) {
    el = thread.appendChild(document.createElement("div"));
    el.className = "empty";
  }
  if (el.dataset.kind !== String(noAgent)) {
    el.dataset.kind = String(noAgent);
    el.innerHTML = html;
  }
}
thread.addEventListener("click", (e) => {
  if (e.target.closest(".empty [data-action=settings]")) openSettings();
});

// ---------- thread rendering ----------

// The current turn.
let turn = null; // { start, statusEl }
let text = null; // { el, text } agent text being streamed
let thought = null; // { row, detail, text, start }
let run = null; // { el, tools: [] } current run of tool calls
let planEl = null;
const tools = new Map(); // toolCallId -> tool
const requests = new Map(); // permission / tab request id -> element
let lastAt = 0;

function resetThread() {
  thread.innerHTML = "";
  turn = text = thought = run = planEl = null;
  tools.clear();
  requests.clear();
  hasMessages = false;
  renderEmpty();
}

const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;

/** Add to the thread, keeping the working line last and following along if at the bottom. */
function append(el) {
  const follow = nearBottom();
  if (!hasMessages) {
    hasMessages = true;
    renderEmpty();
  }
  const status = turn?.statusEl;
  if (status?.isConnected) thread.insertBefore(el, status);
  else thread.appendChild(el);
  if (follow) thread.scrollTop = thread.scrollHeight;
  return el;
}
function keepAtBottom(fn) {
  const follow = nearBottom();
  fn();
  if (follow) thread.scrollTop = thread.scrollHeight;
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/** A new non-text item ends the current text run, so text and tools interleave. */
function breakText() {
  text = null;
  if (thought) finishThought();
}
/** Text or a request after tools ends the run of tool calls. */
function breakRun() {
  breakText();
  if (run) closeRun(run);
  run = null;
}

function render(e, { replay = false } = {}) {
  lastAt = e.at ?? (replay ? lastAt : Date.now());
  switch (e.type) {
    case "user_message":
      breakRun();
      planEl = null;
      hasMessages = true;
      renderEmpty();
      if (e.images?.length || e.elements?.length) {
        const wrap = append(el("div", "user-message"));
        if (e.images?.length) {
          const imgs = wrap.appendChild(el("div", "message-images"));
          for (const src of e.images) {
            if (!/^data:image\/(jpeg|png);base64,/.test(src)) continue;
            const img = imgs.appendChild(el("img"));
            img.src = src;
            img.alt = "Attached image";
          }
        }
        if (e.elements?.length) {
          wrap.appendChild(
            el("div", "message-elements", e.elements.map((p) => `<span class="pill" title="${esc(p.selector)}">${icon("square-dashed-mouse-pointer", { size: 14 })}<span>${esc(p.label)}</span></span>`).join("")),
          );
        }
        if (e.text) wrap.appendChild(el("p", "bubble")).textContent = e.text;
      } else {
        append(el("p", "bubble")).textContent = e.text;
      }
      startTurn(e.at ?? Date.now());
      break;
    case "session_update":
      // Not every update shows (e.g. available_commands_update right after a
      // new session); append() marks the chat as started when one does.
      renderUpdate(e.update);
      break;
    case "permission_request":
      renderPermission(e);
      break;
    case "permission_resolved":
      settlePermission(e.id, e.option);
      break;
    case "tab_request":
      renderTabRequest(e);
      break;
    case "tab_request_resolved":
      settleTabRequest(e);
      break;
    case "error":
      breakRun();
      append(el("div", "turn-error")).textContent = e.message;
      break;
    case "turn_end":
      breakRun();
      if (e.stopReason === "cancelled") append(el("div", "note", `${icon("info", { size: 14 })}<span>Stopped.</span>`));
      endTurn(e.at, e.stopReason);
      break;
    case "note":
      breakRun();
      hasMessages = true;
      renderEmpty();
      append(el("div", "note", `${icon("info", { size: 14 })}<span>${esc(e.text)}</span>`));
      break;
  }
}

function renderUpdate(u) {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      if (u.content?.type !== "text") return;
      if (!text) {
        breakRun();
        text = { el: append(el("div", "md")), text: "" };
      }
      text.text += u.content.text;
      keepAtBottom(() => (text.el.innerHTML = markdown(text.text)));
      break;
    }
    case "agent_thought_chunk": {
      if (u.content?.type !== "text") return;
      text = null;
      if (!thought) startThought();
      thought.text += u.content.text;
      thought.detail.textContent = thought.text;
      break;
    }
    case "tool_call": {
      breakText();
      addTool(u);
      break;
    }
    case "tool_call_update": {
      const t = tools.get(u.toolCallId);
      if (t) updateTool(t, stripNulls(u));
      break;
    }
    case "plan":
      breakRun();
      renderPlan(u.entries ?? []);
      break;
  }
}

const stripNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

// ---------- turn status: working / finished ----------

function startTurn(at) {
  turn = { start: at, statusEl: null };
  renderStatus();
}

function endTurn(at, stopReason) {
  if (!turn) return;
  const end = at ?? Date.now();
  turn.statusEl?.remove();
  if (stopReason !== "cancelled") {
    const when = new Date(end);
    const line = append(el("div", "turn-status"));
    line.textContent = `Worked for ${duration(end - turn.start)} · ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    line.title = when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  turn = null;
}

/** The breathing agent logo and elapsed time while the agent works. */
function renderStatus() {
  const busy = Boolean(state?.bridge.busy);
  if (busy && !turn) turn = { start: lastAt || Date.now(), statusEl: null };
  if (!turn) return;
  if (!busy) return turn.statusEl?.remove();
  if (!turn.statusEl?.isConnected) {
    turn.statusEl = el("div", "turn-status");
    turn.statusEl.setAttribute("role", "status");
    keepAtBottom(() => thread.appendChild(turn.statusEl));
  }
  // Build the logo once: replacing it every tick would restart its animation.
  const logo = agentLogo(currentAgent());
  if (turn.statusEl.dataset.logo !== logo) {
    turn.statusEl.dataset.logo = logo;
    turn.statusEl.innerHTML = `<span class="breathe">${logo}</span><span class="elapsed"></span>`;
  }
  const t = clock(Date.now() - turn.start);
  const elapsed = turn.statusEl.querySelector(".elapsed");
  if (elapsed.textContent !== t) {
    elapsed.textContent = t;
    turn.statusEl.setAttribute("aria-label", `Working, ${t}`);
  }
}
setInterval(() => {
  renderStatus();
  for (const t of tools.values()) if (t.status === "in_progress" || t.status === "pending") renderToolMeta(t);
  if (thought && !thought.done) thought.row.querySelector(".meta").textContent = clock(Date.now() - thought.start);
}, 1000);

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function duration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

// ---------- thinking ----------

function startThought() {
  const wrap = append(el("div", "tools"));
  const row = el("button", "tool running", `${icon("brain", { size: 15 })}<span class="label">Thinking</span><span class="meta"></span>${icon("chevron-right", { size: 14, cls: "chevron" })}`);
  row.type = "button";
  row.setAttribute("aria-expanded", "false");
  const detail = el("div", "tool-detail text");
  detail.hidden = true;
  wrap.append(row, detail);
  row.addEventListener("click", () => toggle(row, detail));
  thought = { row, detail, text: "", start: lastAt || Date.now(), done: false };
}
function finishThought() {
  const t = thought;
  thought = null;
  t.done = true;
  t.row.classList.remove("running");
  t.row.querySelector(".label").textContent = `Thought for ${duration((lastAt || Date.now()) - t.start)}`;
  t.row.querySelector(".meta").textContent = "";
}

function toggle(row, detail) {
  const open = row.getAttribute("aria-expanded") !== "true";
  row.setAttribute("aria-expanded", String(open));
  keepAtBottom(() => (detail.hidden = !open));
}

// ---------- tool calls ----------

const LIVE_SHOWN = 3; // finished rows kept visible while a run is live

function addTool(data) {
  if (!run) {
    run = { el: append(el("div", "tools")), tools: [], start: lastAt || Date.now(), closed: false };
    run.fold = el("button", "tool", `${icon("list-checks", { size: 15 })}<span class="label"></span>${icon("chevron-right", { size: 14, cls: "chevron" })}`);
    run.fold.type = "button";
    run.fold.hidden = true;
    run.fold.setAttribute("aria-expanded", "false");
    run.el.append(run.fold);
    const r = run;
    run.fold.addEventListener("click", () => {
      const open = r.fold.getAttribute("aria-expanded") !== "true";
      r.fold.setAttribute("aria-expanded", String(open));
      keepAtBottom(() => layoutRun(r));
    });
  }
  const t = { id: data.toolCallId, data: {}, status: "pending", start: lastAt || Date.now(), end: null, run };
  t.wrap = el("div", "tool-item");
  t.row = el("button", "tool");
  t.row.type = "button";
  t.detail = el("div", "tool-detail");
  t.detail.hidden = true;
  t.wrap.append(t.row, t.detail);
  t.row.addEventListener("click", () => {
    if (!t.hasDetail) return;
    toggle(t.row, t.detail);
  });
  run.tools.push(t);
  tools.set(t.id, t);
  keepAtBottom(() => run.el.append(t.wrap));
  updateTool(t, data);
}

function updateTool(t, patch) {
  t.data = { ...t.data, ...patch };
  const status = t.data.status ?? "pending";
  if (status !== t.status && (status === "completed" || status === "failed")) t.end = lastAt || Date.now();
  t.status = status;
  keepAtBottom(() => {
    renderTool(t);
    layoutRun(t.run);
  });
}

const KIND_ICONS = { read: "file-text", edit: "file-pen", delete: "trash-2", move: "file-pen", search: "search", execute: "square-terminal", think: "brain", fetch: "globe" };
function toolIcon(d) {
  const ours = browserTool(d.title);
  if (ours) return ours.icon;
  const title = (d.title ?? "").toLowerCase();
  if (title.includes("screenshot")) return "camera";
  if (title.includes("reload")) return "refresh-cw";
  if (/query_selector|find/.test(title)) return "search";
  if (/get_page_content|read/.test(title)) return "file-text";
  return KIND_ICONS[d.kind] ?? "code";
}

function renderTool(t) {
  const d = t.data;
  const running = t.status === "in_progress" || t.status === "pending";
  t.row.className = `tool${running ? " running" : ""}${t.status === "failed" ? " failed" : ""}`;
  const lead = running ? icon("loader-circle", { size: 15, stroke: 2.25, cls: "spin" }) : icon(toolIcon(d), { size: 15 });
  const detail = toolDetail(d);
  t.hasDetail = Boolean(detail);
  t.row.innerHTML = `${lead}<span class="label">${inline(toolTitle(d))}</span><span class="meta"></span>`;
  t.row.disabled = !t.hasDetail;
  t.row.style.cursor = t.hasDetail ? "" : "default";
  if (t.hasDetail) t.row.setAttribute("aria-expanded", String(!t.detail.hidden));
  else t.row.removeAttribute("aria-expanded");
  if (detail !== t.detailHtml) {
    t.detailHtml = detail;
    t.detail.innerHTML = detail ?? "";
    t.detail.className = `tool-detail${detail && !detail.startsWith("<pre") ? " text" : ""}`;
  }
  renderToolMeta(t);
}

function renderToolMeta(t) {
  const meta = t.row.querySelector(".meta");
  if (!meta) return;
  if (t.status === "in_progress" || t.status === "pending") meta.textContent = clock(Date.now() - t.start);
  else if (t.status === "failed") meta.innerHTML = `<span class="status">${icon("x", { size: 14, label: "Failed" })}</span>`;
  else meta.innerHTML = icon("check", { size: 14, label: "Done" });
}

/** Details worth opening: a diff, text output or an image. */
function toolDetail(d) {
  const parts = [];
  for (const c of d.content ?? []) {
    if (c.type === "diff") parts.push(diffHtml(c));
    else if (c.type === "content" && c.content?.type === "text" && c.content.text?.trim()) parts.push(`<pre>${esc(clip(c.content.text))}</pre>`);
    else if (c.type === "content" && c.content?.type === "image" && c.content.data) parts.push(`<img alt="Screenshot" src="data:${esc(c.content.mimeType ?? "image/png")};base64,${c.content.data}">`);
  }
  if (!parts.length && typeof d.rawOutput === "string" && d.rawOutput.trim()) parts.push(`<pre>${esc(clip(d.rawOutput))}</pre>`);
  if (!parts.length && d.rawOutput?.output && typeof d.rawOutput.output === "string") parts.push(`<pre>${esc(clip(d.rawOutput.output))}</pre>`);
  return parts.length ? parts.join("") : null;
}
const clip = (s, n = 6000) => (s.length > n ? s.slice(0, n) + "\n…" : s);

function diffHtml({ oldText, newText }) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  const out = [];
  if (a.length * b.length > 250000) {
    for (const l of a) out.push(["del", l]);
    for (const l of b) out.push(["add", l]);
  } else {
    // Longest common subsequence, then walk it to list removed and added lines.
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) out.push(["ctx", a[i++]]), j++;
      else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) out.push(["add", b[j++]]);
      else out.push(["del", a[i++]]);
    }
  }
  // Only changed lines and one line of context around them.
  const keep = out.map((_, k) => out.slice(Math.max(0, k - 1), k + 2).some(([t]) => t !== "ctx"));
  let html = "";
  let skipped = false;
  out.forEach(([t, l], k) => {
    if (!keep[k]) return (skipped = true);
    if (skipped) html += `<span>…</span>\n`;
    skipped = false;
    html += `<span class="${t}">${t === "add" ? "+ " : t === "del" ? "- " : "  "}${esc(l)}</span>\n`;
  });
  return `<pre>${html.slice(0, 20000)}</pre>`;
}

/**
 * While a run is live, show the last few finished rows and the running ones;
 * fold the rest into "N earlier steps". A closed run is one "Used N tools" row.
 */
function layoutRun(r) {
  if (!r) return;
  const open = r.fold.getAttribute("aria-expanded") === "true";
  const label = r.fold.querySelector(".label");
  if (r.closed) {
    r.fold.hidden = false;
    const n = r.tools.length;
    const failed = r.tools.filter((t) => t.status === "failed").length;
    label.textContent = `Used ${n} tool${n === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;
    let meta = r.fold.querySelector(".meta");
    if (!meta) r.fold.insertBefore((meta = el("span", "meta")), r.fold.querySelector(".chevron"));
    meta.textContent = duration((r.end ?? Date.now()) - r.start);
    for (const t of r.tools) t.wrap.hidden = !open;
    return;
  }
  const finished = r.tools.filter((t) => t.status === "completed" || t.status === "failed");
  const hide = new Set(open ? [] : finished.slice(0, Math.max(0, finished.length - LIVE_SHOWN)));
  r.fold.hidden = hide.size === 0 && !open;
  label.textContent = open ? "Hide earlier steps" : `${hide.size} earlier step${hide.size === 1 ? "" : "s"}`;
  for (const t of r.tools) t.wrap.hidden = hide.has(t);
}

function closeRun(r) {
  if (r.closed) return;
  r.closed = true;
  r.end = Math.max(...r.tools.map((t) => t.end ?? lastAt ?? Date.now()));
  r.fold.setAttribute("aria-expanded", "false");
  keepAtBottom(() => layoutRun(r));
}

// ---------- plan ----------

function renderPlan(entries) {
  if (!planEl) planEl = append(el("div", "plan"));
  const done = entries.filter((p) => p.status === "completed").length;
  const mark = (s) =>
    s === "completed" ? icon("circle-check", { size: 15 }) : s === "in_progress" ? icon("loader-circle", { size: 15, stroke: 2.25, cls: "spin" }) : icon("circle", { size: 15 });
  keepAtBottom(
    () =>
      (planEl.innerHTML =
        `<div class="plan-head">Plan · ${done} of ${entries.length}</div>` +
        entries.map((p) => `<div class="plan-item ${esc(p.status)}">${mark(p.status)}<span>${esc(p.content)}</span></div>`).join("")),
  );
}

// ---------- permission requests ----------

/** The command or code a permission request is about, if the agent says. */
function requestCode(toolCall) {
  const raw = toolCall?.rawInput;
  if (!raw || typeof raw !== "object") return null;
  const cmd = raw.command ?? raw.cmd;
  if (cmd) return { lang: "shell", code: Array.isArray(cmd) ? cmd.join(" ") : String(cmd) };
  const code = raw.code ?? raw.script ?? raw.js;
  if (typeof code === "string") return { lang: "js", code };
  return null;
}

function renderPermission(e) {
  breakRun();
  const sec = append(el("section", "request"));
  sec.setAttribute("aria-label", "Permission request");
  requests.set(e.id, sec);
  const title = e.toolCall?.title ? toolTitle(e.toolCall) : "The agent wants to run a tool";
  const code = requestCode(e.toolCall);
  sec.innerHTML =
    `<h2 class="request-title">${icon(toolIcon(e.toolCall ?? {}), { size: 17 })}<span>${inline(title)}</span></h2>` +
    (code ? codeBlock(code.code, code.lang) : "") +
    `<div class="answers"></div>`;
  sec._title = title;
  sec._kind = toolIcon(e.toolCall ?? {});
  const answers = sec.querySelector(".answers");
  e.options.forEach((opt, i) => {
    const b = el("button", `btn${i === 0 ? " primary" : ""}`);
    b.type = "button";
    b.textContent = opt.name;
    b.addEventListener("click", () => {
      port.postMessage({ type: "permission_response", id: e.id, optionId: opt.optionId });
      settlePermission(e.id, { name: opt.name, kind: opt.kind });
    });
    answers.appendChild(b);
  });
}

/** An answered request collapses to one row that says what was chosen. */
function settlePermission(id, option) {
  const sec = requests.get(id);
  if (!sec || sec.classList.contains("settled")) return;
  sec.classList.add("settled");
  const allowed = option?.kind?.startsWith("allow");
  const outcome = option ? `${icon(allowed ? "check" : "x", { size: 14 })}${esc(allowed ? (option.kind === "allow_always" ? "Always allowed" : "Allowed") : "Denied")}` : "Cancelled";
  sec.innerHTML = `<div class="tools"><div class="tool">${icon(sec._kind, { size: 15 })}<span class="label">${inline(sec._title)}</span><span class="meta">${outcome}</span></div></div>`;
}

// ---------- screenshots of a tab the user left ----------

/**
 * Chrome can only screenshot the tab in front. When the user is elsewhere the
 * screenshot waits; a notification and the toolbar badge bring them back.
 */
function renderTabRequest(e) {
  breakText();
  const line = append(el("p", "tool-wait", "Waiting for you to come back to this tab"));
  line._start = e.at ?? Date.now();
  requests.set(e.id, line);
}
function settleTabRequest(e) {
  const line = requests.get(e.id);
  if (!line) return;
  line.textContent = e.accepted
    ? `Waited ${duration((e.at ?? Date.now()) - line._start)} for you to come back to this tab`
    : `Not switched (${e.reason ?? "declined"}); the agent will check another way.`;
}

// ---------- copy buttons in code blocks ----------

thread.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const code = b.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
  await navigator.clipboard.writeText(code).catch(() => {});
  b.innerHTML = icon("check", { size: 14 });
  setTimeout(() => (b.innerHTML = icon("copy", { size: 14 })), 1200);
});
