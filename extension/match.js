// Which pages a mod applies to. Same logic as agent-bridge/src/match.ts (see
// there for the rule types).

/**
 * Whether one rule matches a URL. Self-contained (no outside references):
 * its source is injected into pages for mods that carry a filter.
 */
export function ruleMatches(rule, href) {
  let url;
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

export function matchesPattern(pattern, url) {
  return ruleMatches({ type: "match", value: pattern }, url);
}

export function filterApplies(filter, url) {
  return filter.any.some((r) => ruleMatches(r, url)) && !filter.none.some((r) => ruleMatches(r, url));
}

export function modApplies(mod, url) {
  if (mod.filter) return filterApplies(mod.filter, url);
  return (
    mod.matches.some((p) => matchesPattern(p, url)) &&
    !(mod.excludeMatches ?? []).some((p) => matchesPattern(p, url))
  );
}
