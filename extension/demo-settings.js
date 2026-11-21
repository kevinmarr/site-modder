// Canned Settings states for checking the page without Chrome or Agent Bridge.
// options.html?demo shows every agent state; ?demo=setup shows first run,
// ?demo=partial a checklist with one step left.

const variant = new URLSearchParams(location.search).get("demo");

const agent = (id, name, installedVersion = null) => ({ id, name, installedVersion });
const list = [
  agent("claude-acp", "Claude Agent", "0.9.1"),
  agent("codex", "Codex", "0.5.0"),
  agent("gemini", "Gemini CLI", "0.21.0"),
  agent("cursor", "Cursor", "1.2.0"),
  agent("opencode", "OpenCode", "0.15.0"),
  agent("cline", "Cline"),
  agent("goose", "Goose"),
  agent("github-copilot", "GitHub Copilot"),
  agent("qwen", "Qwen Code"),
  agent("augment", "Auggie"),
  agent("kimi", "Kimi CLI"),
];
const methods = [
  { id: "claude", name: "Claude subscription", description: "Pro, Max, Team or Enterprise" },
  { id: "console", name: "Anthropic Console", description: "API usage billing" },
];

const full = {
  connected: true,
  userScripts: true,
  agents: { list, installing: { id: "opencode", name: "OpenCode", phase: "downloading", received: 84e6, total: 199e6, update: true }, installError: { id: "goose", message: "the download's checksum didn't match" } },
  auths: {
    "claude-acp": { agent: "Claude Agent", state: "authenticated", accounts: [{ label: "Claude Max", email: "person@example.com" }], methods },
    codex: { agent: "Codex", state: "authenticated", accounts: [], methods: [{ id: "chatgpt", name: "ChatGPT account" }, { id: "apikey", name: "API key" }], signIn: { methodId: "chatgpt", name: "ChatGPT account", output: "" } },
    gemini: {
      agent: "Gemini CLI",
      state: "unauthenticated",
      accounts: [],
      methods: [{ id: "google", name: "Google account", kind: "terminal" }],
      signIn: { methodId: "google", name: "Google account", output: "$ gemini auth login\nCode Assist login required.\nOpen this URL in your browser to authenticate:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=681255809395&scope=openid\n\nEnter the authorization code:" },
    },
    cursor: { agent: "Cursor", state: "unauthenticated", accounts: [], methods: [{ id: "cursor", name: "Cursor account" }], error: "the link expired" },
    opencode: { agent: "OpenCode", state: "authenticated", accounts: [{ label: "OpenRouter API key" }], methods: [] },
  },
  mods: [
    { id: "substack-readable-toc.user.css", site: "substack.com", name: "Substack: legible table of contents", description: "Moves the contents into the margin and highlights the current section", enabled: true, matches: ["*://*.substack.com/*"] },
    { id: "substack-hide-subscribe.user.css", site: "substack.com", name: "Hide in-article subscribe prompts", description: "Removes the subscribe boxes between paragraphs", enabled: false, matches: ["*://*.substack.com/*"] },
    { id: "kl-wine-searcher.user.js", site: "klwines.com", name: "K&L: Wine-Searcher links", description: "Adds a Wine-Searcher link after each bottle", enabled: true, matches: ["*://www.klwines.com/*"] },
    { id: "github-collapse-sidebar.user.js", site: "github.com", name: "GitHub: collapse PR sidebar", description: "Hides the sidebar on pull requests until you hover", enabled: true, matches: ["https://github.com/*/pull/*"] },
    { id: "hn-hide-sidebar.user.js", name: "Hacker News: hide sidebar", error: "needs at least one @match or @include", enabled: true, matches: [] },
  ],
};

const setup = { connected: false, userScripts: false, agents: null, auths: {}, mods: [] };
const partial = { connected: true, userScripts: true, agents: { list: list.map((a) => ({ ...a, installedVersion: null })) }, auths: {}, mods: [] };

export function connect() {
  const listeners = [];
  const state = structuredClone({ setup, partial }[variant] ?? full);
  const emit = () => setTimeout(() => listeners.forEach((l) => l({ type: "state", state: structuredClone(state) })), 0);
  return {
    onMessage: {
      addListener(l) {
        listeners.push(l);
        emit();
      },
    },
    onDisconnect: { addListener() {} },
    postMessage(msg) {
      if (msg.type === "mod_set_enabled") state.mods.find((m) => m.id === msg.id).enabled = msg.enabled;
      if (msg.type === "mod_delete") state.mods = state.mods.filter((m) => m.id !== msg.id);
      if (msg.type === "auth_cancel") delete state.auths[msg.agentId].signIn;
      if (msg.type === "agent_remove") state.agents.list.find((a) => a.id === msg.id).installedVersion = null;
      emit();
    },
  };
}
