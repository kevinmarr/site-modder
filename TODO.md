# TODO

Work left before Eyepatch is a product other people can install. Roughly
in order: the first two sections change the architecture the most.

## 1. Replace the WebSocket with native messaging

Today the extension connects to Agent Bridge over `ws://127.0.0.1:7457`, and
you start Agent Bridge yourself in a terminal. Switch to Chrome native
messaging (`chrome.runtime.connectNative`):

- Chrome starts Agent Bridge on demand and talks to it over stdin/stdout.
  Nothing listens on a port.
- A small host manifest lists Eyepatch's extension ID as the only one
  allowed to start it. That replaces the Origin check and the hardcoded port.
- Agent Bridge needs to become a standalone executable (no Node install), e.g.
  Node's single-executable apps or `bun build --compile`. npm-based agents are
  currently installed with the npm next to Agent Bridge's Node, so this needs
  a plan too (bundle npm, or a Node runtime for agents, like Zed does). The
  browser tools' MCP server (`bin/browser-mcp.mjs`) is also started with
  Agent Bridge's Node; it should become a mode of the executable instead.
- Check that the agent keeps working with the side panel closed: an open
  native messaging port should keep the service worker alive.
- Keep a dev mode: today Agent Bridge watches `extension/` and reloads the
  extension when files change. That should only happen in development.

## 2. Setup flow

The Options page is the setup page: Chrome opens it on install, and it has a
checklist (Agent Bridge running, Allow User Scripts, an agent installed), the
installed agents with sign-in, and the agent catalog. Still missing:

- **Install Agent Bridge** step: a "Download for macOS" button (detect the OS
  with `chrome.runtime.getPlatformInfo()`) on the "Install Agent Bridge"
  step. The page retries `connectNative` until it connects.
- **Check again** for an agent that says it's signed out after you signed in
  elsewhere (e.g. in a terminal): today Agent Bridge only re-asks when the
  agent restarts.
- **Sign in again restarts the agent**, which interrupts replies in progress
  in tabs using it. Warn, or wait until they're done.

Also needed:

- **Installer** per OS: copy Agent Bridge somewhere stable (e.g.
  `~/Library/Application Support/Eyepatch/`) and register the native
  messaging host (a JSON file on macOS and Linux, a registry key on Windows).
- **Code signing:** macOS blocks unsigned downloaded executables, so this needs
  an Apple Developer ID and notarization. Windows has the same issue
  (SmartScreen).
- **Version check:** Agent Bridge and the extension report their versions;
  show an update prompt when Agent Bridge is too old.
- **Uninstall:** removing the extension leaves Agent Bridge behind. Document
  how to remove it.

## 3. Test in real Chrome

Only tested with the fake extension (`npm run fake-extension`), a mock-up of
the side panel, or not at all:

- The Options page in real Chrome (only previewed with made-up data): opening
  on install, installing and removing agents, a complete Sign in again with
  Claude Agent and Codex, and the side panel's Sign in button opening it at
  the right agent. Auto-update with Claude Agent (only tested with Codex).
- The banner hiding by itself after turning on Allow User Scripts.
- Agent Bridge on Linux and Windows (zip handling, npm paths, musl, and the
  browser tools' socket, a named pipe on Windows).
- Browser tools with agents other than Claude Agent and Codex (only those two
  were tried), including whether screenshots reach the model.

## 4. Mods

- **Updates for imported mods:** scripts from Greasy Fork and similar have
  `@updateURL`/`@downloadURL`. Check them, offer the update in Settings, and
  stop once the agent or the user has edited the file.
- **`unsafeWindow`** in isolated scripts is the isolated `window`, not the
  page's. Scripts that grant GM functions and also read page globals need
  `@inject-into page`, where those GM functions don't work.
- **More of the GM API:** `GM_download`, `GM_cookie`, `GM_getTab`/`GM_saveTab`,
  `GM_webRequest`; forbidden request headers in `GM_xmlhttpRequest` (needs
  `declarativeNetRequest`); `GM_notification` click callbacks.
- **UserCSS:** `@var` values are fixed at their defaults. Settings could let
  you change them. Preprocessors (Stylus, Less) aren't supported.

## 5. Chrome Web Store

- Store icon and promo images from the Eyepatch mark.
- Store listing, screenshots, privacy disclosures, and justifications for the
  `userScripts`, `<all_urls>` and (after section 1) `nativeMessaging`
  permissions.
