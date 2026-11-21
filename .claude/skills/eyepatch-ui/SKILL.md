---
name: eyepatch-ui
description: Eyepatch's design system (side panel, settings page, toolbar badge, notifications). Use before creating or changing any UI in extension/: markup, CSS, icons, copy, or states.
---

# Eyepatch UI

Eyepatch is black and white, minimal and quiet. The look was settled in a
design review; this skill is how to keep new UI consistent with it.

## Files

- `extension/ui/eyepatch.css`: every token and component. Pages link it and
  add only page-specific layout. Never hard-code a color, size or radius that
  has a token.
- `extension/icons.js`: `icon(name, { size, stroke, label, cls })` for Lucide
  icons, `fillIcons()` for `<svg data-icon="…" data-size="…">` placeholders,
  and `mark({ size })` for the Eyepatch logo.
- `extension/icons/eyepatch.svg`, `eyepatch-small.svg` (heavier cut for 24 px
  and below, e.g. the toolbar).
- `extension/design.html`: a gallery of every component in light and dark.
  Serve `extension/` over HTTP (modules don't load from `file://`) and check
  your change there and in the real page.

## Rules

- **Color:** text on background, grays for hierarchy. The only color is
  `--danger` (red), for errors and destructive actions. The toolbar badge is
  the one exception (below).
- **No horizontal divider lines**: not between sections, rows, or header and
  content. Use space and type. Two exceptions: a hairline between groups in a
  menu (`.menu-group + .menu-group`), and a Markdown `---` the agent wrote.
- **No accent stripe** on one edge of a box. **No eyebrows** (small uppercase
  labels above headings). **Don't over-use cards**: group with spacing; boxes
  are for floating things (message box, menus, dialogs) and for flows opened
  under a row (`.inset-box`).
- **No explainer copy.** Never narrate how the UI works. Messages are short
  and plain.
- **Icons over text buttons** for generic actions (new chat, more, copy,
  cancel, delete), always with `aria-label`. Text buttons for decisions
  ("Allow", "Authenticate", "Try again").
- **Light and dark** follow Chrome via `prefers-color-scheme`; the tokens
  switch automatically. Check both.
- **Focus rings** only for keyboard use (`body.pointer` after a pointer press).
- **Motion** is minimal and stops under `prefers-reduced-motion`.
- Everything works at a 320 px panel width.

## Type and size

Geist / Geist Mono, bundled as variable fonts in `extension/ui/fonts/`
(SIL OFL) and declared in `eyepatch.css`; never load fonts from the network. Conversation text is
15 px / 1.6; menus, buttons and settings 14.5 px; tool rows 13.5 px; meta
(pills, timestamps, model) 13 px; code 12 px. Page title 34 px, section 22,
site group 16, empty-chat heading 26. Weights 400 / 500 / 600 only. Icons
use stroke 1.75: 18 px for actions, 15 px in tool rows, 14 px inline.

## Side panel

- **Header** (`.panel-header`): agent switcher button (logo, name, chevron),
  then New chat (`square-pen`) and More (`ellipsis`) icon buttons. Nothing
  else: Stop lives in the message box.
- **User message:** `.bubble`, gray, right-aligned.
- **Agent reply:** Markdown in `.md` (h1–h3, lists, tables, quotes, code,
  rules). Code blocks are `.code-block` with a language label and a copy
  button; no syntax colors, only `.k` for emphasis.
- **Tool calls** (`.tools` > `.tool`): quiet 28 px rows: icon, label (file
  names in `<code>`), status at the right. The running row is full-color with
  a spinning `loader-circle` and its elapsed time; its live output may stream
  faintly below (`.tool-live`). While working, earlier rows fold into "N
  earlier steps". A finished run collapses to "Used 9 tools · 41s". Details
  open in place in `.tool-detail`; errors in `.tool-error`.
- **Thinking:** a collapsed row like a tool ("Thought for 8s").
- **Turn status** (`.turn-status`), last line of the turn: while working, the
  current agent's logo breathing plus elapsed time ("0:14"); when done,
  "Worked for 1m 12s · 2:14 PM" (full date on hover).
- **Permission request** (`.request`): title with icon, the code or command in
  a `.code-block`, then the agent's choices: first is `.btn.primary`, the rest
  `.btn`. Once answered it collapses to one tool row ending "✓ Allowed".
- **Screenshots of a background tab:** no card. The screenshot row waits; a
  notification and the "!" badge bring the user back; then a faint line under
  the row says "Waited 12s for you to come back to this tab".
- **Notes** (`.note`): "Stopped.", "Codex couldn't continue this chat. Your
  next message starts a new conversation with Codex."
- **Errors** (`.turn-error`): red text plus an action when there is one.
- **Alerts** (`.alerts` > `.alert`) above the thread: gray block, red icon,
  text, action below. Actions that leave the panel are `.btn.outline` with
  `square-arrow-out-up-right`.
- **Message box** (`.composer`): textarea (Enter sends, Shift+Enter newline),
  then a bar: page pill (`.pill`, globe icon, about 24 characters then "…",
  page title on hover), spacer, model picker (`.model-btn`), and `.send`.
  While the agent works, Send becomes Stop (`.send` with `.stop-square`).
- **Empty chat** (`.empty`): the mark (48 px) and "What do you want to
  modify?" centered above the message box; idea `.chip`s (with icons) sit just
  above the box.
- **More menu** (`.menu`): Settings first, then "Mods on this page" (with
  `.switch`es, an off mod greyed, and each mod's own menu commands as indented
  muted `.menu-item.command` rows under it) and "Recent chats" (title and time), ending
  with "All chats". Groups have a `.menu-label` and a hairline between them.
  Menus can be nearly as tall as the panel.
- **Agent switcher:** agents with logo tiles (`.tile.sm`) and a check on the
  current one; last item "Add more agents" opens Settings.
- **Model and effort:** one button ("Sonnet 5.5 High", effort in faint text)
  and one menu: the models (a filter field when there are more than ~10),
  then a hairline and an "Effort · High ›" row that swaps the menu to the
  effort levels in place, with a back row. No side submenus: the panel is too
  narrow.
- **All chats:** replaces the panel with a back arrow, "All chats" and a
  search field, grouped by site (current site first).
- **No agent:** the mark, "Install an agent to start", and an "Open Settings"
  button; the message box stays but is disabled.

## Settings page

- `.page` column (720 px) with the mark beside the "Settings" title (title
  case). Sections `.section` > `h2`.
- **Setup checklist:** while incomplete, numbered steps (`.step`, not
  checkboxes) with the fix for each; done steps shrink to one muted line with
  a check. When all are done, one line of three checks.
- **Agents:** `.row.agent`: `.tile`, name, account line exactly as the agent
  reports it, and a ⋮ menu (`ellipsis-vertical`) with "Reauthenticate" and
  "Uninstall" (red). Never a trash icon for agents. Not authenticated: a red
  "Not authenticated" line and a `.btn.primary` "Authenticate".
- **Authentication flows** open in an `.inset-box` under the row, and the
  row's ⋮ becomes an X that cancels: choose a method (`.inset-box.list` of
  `.option`s), continue in the browser ("Open page again"), or a command with
  live output (`.terminal`, clickable links) plus a `.field` to paste a code.
  Failure: red reason and "Try again".
- **Add an agent:** a `<dialog class="dialog">` with search and the full list.
  Installing shows "Downloading Claude Agent (84 MB of 199 MB)…" and a
  `.progress` bar; failures show the reason and "Try again".
- **Mods:** grouped by site (`.group-title`, 16 px, globe icon) with
  `.group-items` indented under the name. Each mod: name, one-line
  description, `.switch.lg`, then icon buttons for export (`download`), show
  in folder (`folder-open`) and delete (`trash-2`). Broken mods are listed
  first under a red "Not running" group with their error. An "Import a mod"
  `.add-row` ends the section.
- **Install dialog** (opening a `.user.js`/`.user.css` URL): a `.dialog` with
  the mod's name, description, a `dl` of Version / Runs on / Uses / Can reach /
  From, then a quiet "Cancel" and a primary "Install".
- **Confirmations are inline:** the row becomes a `.confirm` band with the
  consequence, a quiet "Cancel" and a `.btn.danger`.

## Words

- "Authenticate" / "Reauthenticate" / "Not authenticated", never "sign in".
- "Uninstall" an agent; "Delete" a mod.
- "Mods on this page", "Recent chats", "All chats", "Add more agents",
  "Settings".
- Sentence case everywhere except the "Settings" title.

## Toolbar badge and notifications

The badge is Chrome's own (`chrome.action.setBadgeText` /
`setBadgeBackgroundColor` / `setBadgeTextColor`), white text, one set of
colors for both themes, in priority order:

| State | Text | Background |
| --- | --- | --- |
| Needs you (permission or tab) | `!` | `#D93025` |
| Working | `•••` | `#1A73E8` |
| Done, unseen | `✓` | `#188038` |
| Mods running | count | `#5F6368` |

The toolbar icon is `eyepatch-small.svg`. Notifications use the mark as the
icon, the tab's title as the title, and one short line.
