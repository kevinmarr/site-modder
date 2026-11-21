# Product spec for design

What the product does and every screen and state that needs a design. It
describes function only. How anything looks is up to the designer.

## The product

A Chrome extension for changing how websites look and work by chatting with an
AI coding agent. You open a chat beside a web page and ask for a change ("hide
the sidebar", "make this readable in dark mode", "add a link to Wine-Searcher
next to every bottle"). The agent inspects the page, writes a **mod** (a small
CSS and/or JavaScript file for that site), and the change appears on the page
right away. The mod keeps applying every time you visit that site, until you
turn it off.

The agent is a coding agent installed on the user's own computer (Claude,
Codex, Gemini CLI, Cursor, GitHub Copilot and about 40 others). A small helper
program on the computer, **Agent Bridge**, connects the extension to it.

The working name is "site-modder". It will change, and the logo is a
placeholder, so the design shouldn't depend on either.

Audience: people comfortable with AI chat tools, from casual users to
developers. Tone: minimal and modern, like the side-panel assistants of
Gemini in Chrome, Claude in Chrome and ChatGPT.

## Platform constraints

- **The side panel** is Chrome's panel docked to the right of the page. The
  user can resize it: about 320 px minimum, typically 360–450 px, up to about
  half the window. Every layout must work at 320 px. Chrome draws its own
  thin title bar above the panel (extension name and a close button), outside
  our control.
- **The settings page** opens in a normal browser tab, full width.
- **The toolbar button** is a 16 px icon in Chrome's toolbar. It can carry a
  small badge of 1–4 characters. Chrome draws the badge; we choose only its
  text, background color and text color.
- **System notifications** come from Chrome (macOS/Windows style). We control
  only the title, a line of text and the icon.
- **Light and dark:** follow Chrome's color mode automatically.
- **Icons:** Lucide (lucide.dev).
- **Fonts:** a bundled web font is allowed. Show how each direction looks with
  the system font too, so the two can be compared.
- Agents each have a small monochrome logo (SVG). Models are named by the
  agent ("Sonnet 5.5", "GPT-5.2 Codex", …).

## 1. Side panel: the chat

Each browser tab has its own side panel and its own chat, with its own agent
and model. Switching tabs switches panels. A chat continues when the tab moves
to another page.

### Top of the panel

- **The current agent:** its logo and name (e.g. "Claude Agent").
- **Stop:** visible only while the agent is working.
- **New chat:** starts a fresh chat with the same agent. It interrupts a reply
  in progress, deliberately.
- **Agent switcher:** lists the installed agents with the current one
  marked. Picking another starts a new chat with it. The last item, "Add more
  agents", opens the settings page.
- **More menu:**
  - *On this page:* the mods that apply to the current page, each with an
    on/off switch. Hidden when there are none. A page usually has 0–3.
  - *Recent chats:* up to 15 past chats, chats from the current site first.
    Each shows its title (the first message, truncated) and when it was last
    active ("now", "5m", "3h", "2d", "Nov 11"). Clicking one restores it into
    this tab. When there are more, "All chats" opens a full scrollable list
    with a way back.
  - *Settings:* opens the settings page.

### Conversation

Messages alternate between the user and the agent. A turn can include:

- **User message:** plain text, usually one or two sentences.
- **Agent reply:** Markdown that streams in as it's written: headings
  (h1–h3), paragraphs, bold, italic, inline code, links, bulleted and numbered
  lists (nested), tables, block quotes, code blocks (CSS, JS, JSON,
  shell), horizontal rules. Some agents stream word by word, others send a
  whole paragraph at a time. Replies are usually short (a few sentences),
  sometimes long with code.
- **Thinking:** some agents share their reasoning as text before answering.
  It should be available but out of the way (collapsed by default).
- **Tool calls:** the agent's actions, often 5–20 per turn, interleaved with
  its text. Each has a short title ("Read github-dark.user.css", "Edit hn-tweaks.user.js",
  "get_page_content", "screenshot", "Run `npm test`") and a status: pending,
  running, done or failed. Some have details (file path, the edit as a diff,
  command output, a screenshot) that are worth viewing but shouldn't crowd the
  conversation.
- **Plan:** some agents publish a short to-do list that updates as they work
  (items pending, in progress, done).
- **Permission request:** the agent wants to do something that needs
  approval, such as running a shell command or running JavaScript in the page.
  It shows what (a title, sometimes the command or code) and 2–4 choices from
  the agent, e.g. "Allow", "Always allow in this chat", "Deny". After the
  user answers, the request stays in the history but is clearly settled. The
  agent waits until the user answers.
- **"Switch to this tab" request:** the agent needs a screenshot but the
  user is looking at another tab. It names the tab and offers "Switch to tab"
  and "Not now". It resolves on its own if the user switches back.
- **Notes:** small informational lines, e.g. "Stopped." after the user stops
  the agent, or "Codex can't continue earlier chats. Your next message starts a
  new conversation with Codex."
- **Errors:** a turn can fail ("The agent is busy", "Sign in to Codex to
  continue", a network error).
- **Working:** between sending and the first reply, and while tools run, it
  should be clear the agent is busy (several seconds to several minutes).

The panel scrolls with the conversation and stays at the bottom while
following along, unless the user scrolls up to read.

### Empty chat

Before the first message. It's an invitation to ask for a change to the
current page and can suggest ideas. It's also what a new chat looks like.

### Message box

- Multi-line text input. Enter sends, Shift+Enter adds a line.
- **Page context:** which page the message is about (the current tab's
  site or page title). The message is always about this tab.
- **Model picker:** the current agent's models. Lists range from 3 to about 50
  entries. Hidden if the agent offers no choice.
- **Send.** Disabled while the agent is working or can't be used.

### Alerts in the panel

Shown above the conversation, until resolved:

- Agent Bridge isn't running (the extension can't reach it).
- The agent needs the user to sign in, with a **Sign in** action that opens
  the settings page at that agent.
- Chrome's "Allow User Scripts" switch is off (mods can't run without it), with
  an action that opens Chrome's extension settings.
- A mod has an error and isn't running ("Mod hide-sidebar.user.js isn't
  running: needs at least one @match or @include").

### No agent installed yet

The panel can't chat until an agent is installed. It says so and links to the
settings page.

## 2. Settings page

A full browser tab. It doubles as first-run setup: Chrome opens it
right after the extension is installed.

### Setup checklist

Three items, each either done or needing action:

1. Agent Bridge is installed (or: how to install it).
2. User scripts are allowed (or: an action opening Chrome's extension
   settings to turn on "Allow User Scripts").
3. A coding agent is installed (or: pick one below).

Once all three are done, the checklist matters less and could become
compact.

### Agents

A list of installed agents. Each shows its logo and name, and what the agent
reports about the account it's signed in with, shown as reported ("Claude Max
· person@example.com", "Anthropic API key", or nothing). When an agent is
signed out, that's shown as a problem to fix.

Actions per agent:

- **Sign in** (when signed out) or **Sign in again** (optional, e.g. to
  switch accounts). Neither should look like an alert when everything is fine.
  - If the agent offers several ways to sign in, the user picks one first
    (each has a name and sometimes a description, e.g. "Claude subscription"
    or "Anthropic Console (API usage billing)").
  - Some ways run in the agent and open the browser by themselves: show that
    it's in progress, with Cancel.
  - Others are a command whose output is shown live (a few lines of terminal
    text with clickable links), plus an input to paste a code back, and
    Cancel.
  - Failure shows the reason and **Try again**.
- **Remove** the agent (with confirmation). Tabs using it switch to another
  agent.
- While an update installs in the background: a quiet "Updating…".

**Add an agent:** opens a searchable or scrollable list of about 40 available
agents (logo and name, alphabetical). Picking one installs it: a progress
indicator ("Downloading Claude Agent (84 MB of 199 MB)…", "Installing…"),
then it joins the list. Installing can fail with a message and a way to
retry.

### Mods

Every mod, grouped by site (e.g. "substack.com", "klwines.com"). Each shows its
name, a one-line description, an on/off switch, **Export**, **Show in folder**
and **Delete** (with confirmation). Mods with errors are listed separately
with the error. Typical counts: a few to a few dozen. Below the list, **Import
a mod** takes userscripts (`.user.js`) and UserCSS styles (`.user.css`).

Opening a `.user.js` or `.user.css` URL opens Settings with an install dialog:
the mod's name and description, the sites it runs on, the GM functions it uses
and the hosts it can reach, and Install / Cancel.

## 3. Toolbar button

Its badge shows, in order of priority:

1. **Needs you:** a permission request or tab request is waiting.
2. **Working:** the agent in this tab is working.
3. **Done:** the agent finished while the user wasn't looking.
4. **Mod count:** how many mods are running on this page.
5. Nothing.

Clicking the button opens this tab's side panel.

## 4. Notifications

When the user isn't looking at the tab's panel, a system notification says
the agent finished (with the start of its reply), needs permission, or wants
the user to switch back to the tab. Clicking one opens that tab and its
panel.

## Sample content

- Sites: substack.com, github.com, klwines.com, news.ycombinator.com,
  docs.python.org.
- Mods: "Substack: legible table of contents", "Hide in-article subscribe
  prompts", "K&L: Wine-Searcher links", "GitHub: collapse PR sidebar".
- Chats: "Make the table of contents readable", "Add Wine-Searcher links next
  to each bottle", "Hide the subscribe prompts", "dark mode for the docs".
- Agents: Claude Agent, Codex, Gemini CLI, Cursor, GitHub Copilot, OpenCode.
- Models (Claude Agent): Default (recommended), Opus 5.5, Sonnet 5.5,
  Haiku 5.5.
