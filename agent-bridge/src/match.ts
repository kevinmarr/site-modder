/**
 * Which pages a mod applies to, decided exactly as the extension will.
 * Same logic as extension/match.js.
 *
 * Most mods use only Chrome match patterns
 * (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns),
 * which Chrome checks itself. Userscript `@include` globs and regexes and
 * UserCSS `@-moz-document` rules can't be expressed as match patterns, so those
 * mods register broadly and carry a `filter` that's checked in the page too.
 */

export type ModRule =
  | { type: "all" }
  /** A Chrome match pattern. */
  | { type: "match"; value: string }
  | { type: "regex"; source: string; flags?: string }
  /** UserCSS `domain()`: the host or any subdomain. */
  | { type: "domain"; value: string }
  /** UserCSS `url()`: the exact URL. */
  | { type: "url"; value: string }
  /** UserCSS `url-prefix()`. */
  | { type: "prefix"; value: string };

/** Applies where any `any` rule matches and no `none` rule does. */
export type ModFilter = { any: ModRule[]; none: ModRule[] };

/**
 * Whether one rule matches a URL. Self-contained (no outside references) so
 * the extension can inject its source into pages.
 */
export function ruleMatches(rule: ModRule, href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  const host = url.hostname.toLowerCase();
  switch (rule.type) {
    case "all":
      return ["http", "https", "file", "ftp"].includes(scheme);
    case "regex":
      try {
        return new RegExp(rule.source, rule.flags ?? "").test(href);
      } catch {
        return false;
      }
    case "domain": {
      const d = rule.value.toLowerCase();
      return host === d || host.endsWith("." + d);
    }
    case "url":
      return href === rule.value || href.split("#")[0] === rule.value;
    case "prefix":
      return href.startsWith(rule.value);
    case "match": {
      const pattern = rule.value;
      if (pattern === "<all_urls>") return ["http", "https", "file", "ftp", "ws", "wss"].includes(scheme);
      const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
      if (!m) return false;
      const [, pScheme, pHost, pPath] = m;
      // `*` scheme means http or https only.
      if (pScheme === "*" ? scheme !== "http" && scheme !== "https" : pScheme !== scheme) return false;
      // Ports aren't part of the host match.
      const want = pHost.toLowerCase().replace(/:\d+$/, "");
      if (scheme !== "file" && want !== "*") {
        if (want.startsWith("*.")) {
          const base = want.slice(2);
          if (host !== base && !host.endsWith("." + base)) return false;
        } else if (host !== want) {
          return false;
        }
      }
      const glob = new RegExp("^" + pPath.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      return glob.test(url.pathname + url.search);
    }
  }
  return false;
}

export function matchesPattern(pattern: string, url: string): boolean {
  return ruleMatches({ type: "match", value: pattern }, url);
}

export function filterApplies(filter: ModFilter, url: string): boolean {
  return filter.any.some((r) => ruleMatches(r, url)) && !filter.none.some((r) => ruleMatches(r, url));
}

export function modApplies(
  mod: { matches: string[]; excludeMatches?: string[]; filter?: ModFilter },
  url: string,
): boolean {
  if (mod.filter) return filterApplies(mod.filter, url);
  return (
    mod.matches.some((p) => matchesPattern(p, url)) &&
    !(mod.excludeMatches ?? []).some((p) => matchesPattern(p, url))
  );
}
