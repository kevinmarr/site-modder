// A canned chat for checking the side panel without Chrome or Agent Bridge:
// every Markdown element, tool calls with details, thinking, a plan and a
// permission request. Open sidepanel.html?demo (serve extension/ over HTTP).
// Send any message to watch a reply stream in; "slow" streams word by word,
// anything else streams a paragraph at a time.

export const tab = { url: "https://thequietreader.substack.com/p/the-quiet-death-of-the-table-of-contents", title: "The quiet death of the table of contents" };

const MODELS = ["Default (recommended)", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"].map((name) => ({ value: name.toLowerCase().replace(/\W+/g, "-"), name }));

const state = {
  bridge: { connected: true, agentId: "claude-acp", agent: "Claude Agent", ready: true, images: true, busy: false, needsAgent: false },
  auth: null,
  model: { current: "sonnet-5-5", options: MODELS },
  effort: { current: "high", options: ["Default", "Low", "Medium", "High", "Xhigh", "Max"].map((name) => ({ value: name.toLowerCase(), name })) },
  agents: {
    selected: "claude-acp",
    list: [
      { id: "claude-acp", name: "Claude Agent", installedVersion: "1" },
      { id: "codex", name: "Codex", installedVersion: "1" },
      { id: "gemini", name: "Gemini CLI", installedVersion: "1" },
    ],
  },
  userScripts: true,
  modErrors: {},
  mods: [
    { id: "substack-readable-toc", name: "Substack: legible table of contents", description: "Moves the contents into the margin", enabled: true, matches: ["*://*.substack.com/*"] },
    { id: "substack-hide-subscribe", name: "Hide in-article subscribe prompts", enabled: false, matches: ["*://*.substack.com/*"] },
  ],
  sessionId: "demo",
};

const REPLY = `# Readable contents

The table of contents now sits in the *left margin*, and the current section is **highlighted** as you scroll. The styles are in \`substack-readable-toc.user.css\`; turn it off any time from the menu or in [Settings](https://example.com/settings).

## Breakpoints

| Width | Position | Behaviour |
| --- | --- | --- |
| 1400 px and up | Left margin | Always shown |
| 1100–1399 px | Left margin | Collapsed to dots |
| Below 1100 px | Hidden | There's no margin |

### What changed

- Headings are bigger and easier to scan
  - Text goes from 11 px to 14 px
  - The current section is **bold**
- Each heading links to its section
- Long titles wrap instead of being cut off

1. Open a long post and scroll to check the highlight
2. Tell me if the margin feels too wide
3. Turn it off from the menu if it gets in the way

> Posts with fewer than three headings keep it hidden.

\`\`\`js
const links = document.querySelectorAll(".toc-gutter a");
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) setActive(e.target.id);
  }
});
\`\`\`

---

That's it. A ~~very~~ long URL wraps too: https://thequietreader.substack.com/p/the-quiet-death-of-the-table-of-contents#section-four`;

const t0 = Date.now() - 6 * 60_000;
const at = (s) => t0 + s * 1000;
const tool = (id, title, kind, s, extra = {}) => [
  { type: "session_update", at: at(s), update: { sessionUpdate: "tool_call", toolCallId: id, title, kind, status: "in_progress" } },
  { type: "session_update", at: at(s + 2), update: { sessionUpdate: "tool_call_update", toolCallId: id, status: extra.status ?? "completed", ...extra } },
];
const chunk = (text, s, kind = "agent_message_chunk") => ({ type: "session_update", at: at(s), update: { sessionUpdate: kind, content: { type: "text", text } } });

const TRANSCRIPT = [
  { type: "user_message", at: at(0), text: "Make the table of contents readable" },
  chunk("The page builds its contents from the h2 and h3 headings inside the post body. ", 2, "agent_thought_chunk"),
  chunk("I can lift that list into the left margin with a mod and highlight the visible section with an IntersectionObserver.", 4, "agent_thought_chunk"),
  chunk("I’ll look at how the page builds its table of contents first.", 9),
  ...tool("t1", "mcp__eyepatch__get_page_content", "other", 10),
  ...tool("t2", "mcp__eyepatch__query_selector_all", "other", 13, { rawInput: { selector: "nav.toc" } }),
  ...tool("t3", "Create mod `substack-readable-toc`", "edit", 16),
  ...tool("t4", "Edit `substack-readable-toc.user.css`", "edit", 19, {
    content: [{ type: "diff", path: "substack-readable-toc.user.css", oldText: ".toc-gutter a { color: inherit; }\n.toc-gutter { width: 180px; }", newText: ".toc-gutter a { color: inherit; opacity: .6; }\n.toc-gutter a.active { opacity: 1; font-weight: 600; }\n.toc-gutter { width: 180px; }" }],
  }),
  ...tool("t5", "Run `npm test`", "execute", 22, { status: "failed", rawOutput: "FAIL mod.test.js\n  ✕ highlights the visible section (12 ms)\n\nTests: 1 failed, 3 passed" }),
  ...tool("t6", "Edit `substack-toc-highlight.user.js`", "edit", 26),
  ...tool("t7", "Run `npm test`", "execute", 29, { rawOutput: "PASS mod.test.js\nTests: 4 passed" }),
  { type: "permission_request", at: at(32), id: "p1", toolCall: { title: "mcp__eyepatch__run_js", rawInput: { code: "return [...document.querySelectorAll('.toc-gutter a')].length;" } }, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "b", name: "Always allow in this chat", kind: "allow_always" }, { optionId: "c", name: "Deny", kind: "reject_once" }] },
  { type: "permission_resolved", at: at(35), id: "p1", option: { name: "Allow", kind: "allow_once" } },
  ...tool("t8", "mcp__eyepatch__screenshot", "other", 36),
  { type: "session_update", at: at(40), update: { sessionUpdate: "plan", entries: [{ content: "Find the headings", status: "completed" }, { content: "Write the mod", status: "completed" }, { content: "Check it on a long post", status: "completed" }] } },
  chunk(REPLY, 44),
  { type: "turn_end", at: at(72), stopReason: "end_turn" },
];

const HISTORY = [
  ["Add Wine-Searcher links next to each bottle", "https://www.klwines.com/Products?filters=sv2_206", 3],
  ["Hide the subscribe prompts", "https://thequietreader.substack.com/p/notes", 50],
  ["dark mode for the docs", "https://docs.python.org/3/library/asyncio.html", 60 * 30],
  ["Collapse the PR sidebar", "https://github.com/acme/web/pull/482", 60 * 60 * 26],
].map(([title, url, minsAgo], i) => ({ sessionId: `h${i}`, title, url, agent: "Claude Agent", updatedAt: new Date(Date.now() - minsAgo * 60_000).toISOString() }));

export function connect() {
  const listeners = [];
  const emit = (msg) => setTimeout(() => listeners.forEach((l) => l(structuredClone(msg))), 0);
  const event = (e) => emit({ type: "event", event: { at: Date.now(), ...e } });
  const setBusy = (busy) => {
    state.bridge.busy = busy;
    emit({ type: "state", state });
  };
  let timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  function respond(text, images, elements) {
    event({ type: "user_message", text, ...(images?.length ? { images: images.map((i) => i.thumb) } : {}), ...(elements?.length ? { elements } : {}) });
    setBusy(true);
    const words = /slow/i.test(text);
    let t = 600;
    later(t, () => event({ type: "session_update", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking what's on the page before changing it." } } }));
    t += 1500;
    for (const [id, title, kind] of [["n1", "mcp__eyepatch__get_page_content", "other"], ["n2", "mcp__eyepatch__query_selector_all", "other"], ["n3", "Edit `substack-readable-toc.user.css`", "edit"], ["n4", "Edit `substack-toc-highlight.user.js`", "edit"], ["n5", "mcp__eyepatch__reload_tab", "other"]]) {
      later(t, () => event({ type: "session_update", update: { sessionUpdate: "tool_call", toolCallId: id + t, title, kind, status: "in_progress" } }));
      t += 1200;
      later(t, () => event({ type: "session_update", update: { sessionUpdate: "tool_call_update", toolCallId: id + (t - 1200), status: "completed" } }));
      t += 200;
    }
    const pieces = words ? REPLY.split(/(?<=\s)/) : REPLY.split(/(?<=\n\n)/);
    for (const p of pieces) {
      later(t, () => event({ type: "session_update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p } } }));
      t += words ? 25 : 350;
    }
    later(t, () => {
      event({ type: "turn_end", stopReason: "end_turn" });
      setBusy(false);
    });
  }

  const port = {
    onMessage: {
      addListener(l) {
        listeners.push(l);
        if (listeners.length === 1) emit({ type: "init", state, transcript: TRANSCRIPT });
      },
    },
    onDisconnect: { addListener() {} },
    postMessage(msg) {
      switch (msg.type) {
        case "prompt":
          return respond(msg.text, msg.images, msg.elements);
        case "pick_element":
          return later(800, () => emit({ type: "picked", element: { selector: "article > nav.toc", label: "nav.toc", html: "<nav class=\"toc\"></nav>" } }));
        case "pick_cancel":
          return;
        case "cancel":
          timers.forEach(clearTimeout);
          timers = [];
          event({ type: "turn_end", stopReason: "cancelled" });
          return setBusy(false);
        case "new_session":
          timers.forEach(clearTimeout);
          state.bridge.busy = false;
          emit({ type: "init", state, transcript: [] });
          // Agents announce their commands right after a new session; nothing shows for it.
          return event({ type: "session_update", update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
        case "history_list":
          return emit({ type: "history", items: HISTORY });
        case "set_model":
          state.model.current = msg.value;
          return emit({ type: "state", state });
        case "set_effort":
          state.effort.current = msg.value;
          return emit({ type: "state", state });
        case "mod_set_enabled":
          state.mods.find((m) => m.id === msg.id).enabled = msg.enabled;
          return emit({ type: "state", state });
        case "permission_response":
          return event({ type: "permission_resolved", id: msg.id });
      }
    },
  };
  return port;
}
