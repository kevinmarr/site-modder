# Eyepatch

Modify any website by chatting with a coding agent from Chrome's side panel.
The agent (Claude, Codex, Gemini CLI or any other ACP agent) runs on your
machine and talks to the extension through **Agent Bridge**, a small local
program, using the
[Agent Client Protocol](https://agentclientprotocol.com).

```
side panel ⇄ service worker ⇄ WebSocket ⇄ Agent Bridge ⇄ ACP (stdio) ⇄ agent
                    │                          │
            runs browser tools ◀── MCP (stdio) ┘
            registers mods as user scripts ◀── watches ~/.eyepatch/mods
```

## Setup

1. Start Agent Bridge (Node 22+):

   ```bash
   cd agent-bridge && npm install && npm start
   ```

2. Load the extension: open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked** and pick the `extension/` folder.
3. Chrome opens Eyepatch's Settings page, which doubles as setup: it checks
   that Agent Bridge is installed, links to **Allow User Scripts** (mods need
   it), and installs a coding agent.
4. Click the toolbar icon to open the side panel and ask for a change.

## Tabs and chats

Each tab has its own side panel and its own chat. Switching tabs hides the
panel, and switching back shows it again with the conversation intact.
Several tabs can have chats going at once, each with its own agent and model,
and each agent's browser tools act only on its own tab. A chat continues if
the tab navigates to another page. Closing the tab ends the chat; it's saved
in `~/.eyepatch/sessions/`.

Tabs using the same agent share one copy of it running in Agent Bridge. An
agent that no open tab uses is stopped.

The ⋮ menu in the side panel lists the mods for the page you're on (with an
on/off switch each), your recent chats, and Settings. Clicking a past chat
restores it into the tab. Agents that can reopen a conversation over ACP
(Claude Agent and Codex do) carry on where it left off; others show the old
chat and start a new conversation with your next message.

## Agents

Agents are installed and removed on the Options page (right-click the toolbar
icon → **Options**). New tabs start with the agent you installed or picked
most recently. The list comes from the [ACP registry](https://agentclientprotocol.com/get-started/registry),
the same one Zed uses. Like Zed, Eyepatch installs its own copy of the agent
you pick in `~/.eyepatch/agents/<id>/<version>`, so it always has a version
that works with ACP:

- Agents published as downloads (Claude Agent, Cursor, OpenCode, …) are
  downloaded and checked against the registry's checksum.
- Agents published as npm packages (Codex, Gemini CLI, GitHub Copilot, …) are
  installed with the npm that came with Agent Bridge's Node.
- When the registry lists a newer version, it's installed in the background and
  used once the agent is idle. The old copy is then removed.

Copies can be large: Claude Agent is about 200 MB to download and 425 MB on
disk, since it includes Claude Code. Agents usually share sign-in with their
regular install, so if you already use one you're probably signed in.

To start a new chat with a different agent, click the agent's name at the top
of the side panel and pick one of your installed agents; **Add more agents**
opens the Options page. The model
menu under the message box is per tab too; the model you pick last for an
agent is what its new chats start with.

The browser tools reach every agent as an ordinary stdio MCP server named
`eyepatch`, which ACP requires all agents to support. The agent starts
`agent-bridge/bin/browser-mcp.mjs` for each chat; it's only a pipe to Agent
Bridge over a local socket (`~/.eyepatch/tools-<port>.sock`, owner-only),
with a per-chat token that ties its tool calls to that chat's tab.

## Signing in

Eyepatch uses your agent's existing sign-in; it doesn't manage credentials.
If you're already signed in to Claude Code or Codex, there's nothing to do.

The Options page lists each installed agent with whatever account it reports
(Claude Agent reports one; Codex doesn't) and **Reauthenticate** in its ⋮ menu.
Its sign-in options come from the agent over ACP, so this works for any ACP agent.
Some the agent runs itself. Others are commands Agent Bridge runs, relaying the
output (with clickable links) and a box to paste a code back. While the
Options page is open, Agent Bridge keeps every installed agent running so they
can report their status.

If an agent reports it's signed out, the side panel shows an **Authenticate**
button that opens the Options page at that agent.

## Working in the background

Agents keep working when the side panel is closed or you switch tabs. When
you're not watching a tab's panel, Chrome notifications (naming the tab) tell
you when its agent:

- finishes a turn,
- needs permission, or
- needs you to switch back to a tab so it can take a screenshot.

Clicking a notification brings up that tab with its side panel open.

Each tab's toolbar badge shows the same thing at a glance: a red `!` when it
needs you, a blue `•••` while its agent is working, and a green `✓` when it has
finished and you haven't looked yet. Otherwise it shows how many mods are
running on the page, in gray.
On macOS, Chrome itself needs notification permission (System Settings →
Notifications → Google Chrome).

## Mods

Each mod is one file in `~/.eyepatch/mods/`, in a format that userscript
managers already use, so mods move between Eyepatch and those managers
unchanged:

- `<id>.user.css` is a [UserCSS](https://github.com/openstyles/stylus/wiki/Writing-UserCSS)
  style, as Stylus uses: a `/* ==UserStyle== */` header, then CSS in
  `@-moz-document` blocks that say where it applies.
- `<id>.user.js` is a userscript, as Tampermonkey, Violentmonkey and
  Greasemonkey use: a `// ==UserScript==` header (`@match`, `@grant`, …),
  then the script.

The agent's working directory is `~/.eyepatch/mods`, and `CLAUDE.md`/`AGENTS.md`
there describe the formats. Whether each mod is on is kept in
`~/.eyepatch/mods-state.json`, not in the file. Mods from before this format
(folders with `mod.json`) are converted when Agent Bridge starts. The old
folders go to `~/.eyepatch/trash/`.

The Options page lists every mod by site, with an on/off switch, export,
show-in-folder and delete (deleted mods move to `~/.eyepatch/trash/`), and
**Import a mod** for `.user.js` and `.user.css` files. Opening a `.user.js` or
`.user.css` URL, for example Greasy Fork's Install button, offers to install
it. You can also drop files into the folder.

Files apply live. Styles hot-swap in every open tab, including when they're
turned on or off. A script change reloads the tab
whose agent made it, not other tabs on the same site (they pick it up when they
next load). Edits you make by hand, or with Claude Code in a terminal, reload
every matching tab.

### Userscript support

Scripts run the way userscript managers run them: inside a function, after
their `@require` files (downloaded once into `~/.eyepatch/cache/`, checked
against any `#sha256=…`). Supported:

- **Where:** `@match`, `@exclude-match`, `@include` and `@exclude` (globs, `.tld`
  and `/regexes/`), `@run-at`, `@noframes`.
- **World:** as in Tampermonkey, a script that grants nothing runs in the page's
  own JS world, and one with grants runs in an isolated world that sees only the
  DOM. `@inject-into page|content` (Violentmonkey) and `@sandbox` (Tampermonkey)
  choose explicitly.
- **GM API** (`GM_*` and `GM.*`): `addStyle`, `addElement`, `getValue`,
  `setValue`, `deleteValue`, `listValues`, `getValues`, `setValues`,
  `deleteValues`, `addValueChangeListener` and `removeValueChangeListener`
  (stored in the extension, synced across tabs), `xmlhttpRequest` (made by the
  extension, so cross-origin, limited to the page's host and `@connect` hosts),
  `registerMenuCommand` and `unregisterMenuCommand` (listed under the mod in the
  side panel's menu), `openInTab`, `notification`, `setClipboard`,
  `getResourceText`, `getResourceURL`, `info` and `log`.
- **Not supported:** other `GM_` functions (`GM_download`, `GM_cookie`, …) throw
  an error saying so, and Settings shows the grant as unsupported.
  `unsafeWindow` is the isolated world's `window`; use `@grant none` or
  `@inject-into page` for page globals. `@updateURL` updates aren't checked.
  `GM_xmlhttpRequest` can't set forbidden headers (`Cookie`, `User-Agent`, …).

UserCSS styles must be plain CSS: `@var` defaults become CSS custom properties,
and preprocessors (`@preprocessor stylus`/`less`) aren't supported.

## Dev loop

- **Extension:** while Agent Bridge runs, saving any file in `extension/`
  calls `chrome.runtime.reload()`, so you never have to visit
  `chrome://extensions`. Reopen the side panel after a reload.
- **Agent Bridge:** `npm run dev` restarts on change. The extension reconnects by
  itself.
- **UI without Chrome:** serve `extension/` over HTTP (e.g.
  `python3 -m http.server -d extension`) and open `sidepanel.html?demo` for a
  canned chat with every Markdown element, tool calls and a permission request
  (send a message to watch a reply stream in; include "slow" to stream word by
  word), `options.html?demo` (or `?demo=setup`) for Settings, and
  `design.html` for every component. The design rules are in
  `.claude/skills/eyepatch-ui`.
- **Without Chrome:** `npm run fake-extension -- "make the h1 red"` drives the
  Agent Bridge with canned page data. Add `FAKE_AGENT=claude-acp` (any registry
  id) to pick and install that agent first.
- **Tests:** `npm test` checks match patterns and mod parsing. `npm run
  test:e2e` loads the extension in Playwright's Chromium with a real Agent
  Bridge and checks that mods run: styles, hot swap, the GM API, menu commands,
  install, import and export. It needs Playwright installed, and port 7457
  free.

## Config (env vars)

| Var | Default | |
| --- | --- | --- |
| `EYEPATCH_PORT` | `7457` | The extension currently hardcodes 7457 |
| `EYEPATCH_HOME` | `~/.eyepatch` | Mods live in `$HOME/mods` |
| `EYEPATCH_AGENT` | the agent picked in the side panel | Run this ACP agent command instead, e.g. `gemini --acp` |
| `EYEPATCH_EXTENSION_ID` | any extension | Only accept connections from this extension ID |

## Security notes

- Page content is untrusted input to an agent that runs on your machine. File
  edits in the mods dir are auto-accepted. Read-only browser tools and
  `reload_tab` run without asking. `run_js` always asks in the side panel, even with
  agents that approve tool calls themselves (Codex); shell commands and
  anything else ask when the agent asks.
- The WebSocket listens on 127.0.0.1 only and rejects any Origin that isn't a
  `chrome-extension://` URL. Set `EYEPATCH_EXTENSION_ID` to pin it to yours.

## License

MIT. See [LICENSE](LICENSE).
