/**
 * Parsing mod files. A mod is one file in the mods directory, in one of the
 * two formats userscript managers already use:
 *
 * - `<id>.user.js`: a userscript, as for Tampermonkey, Violentmonkey and
 *   Greasemonkey (a `// ==UserScript==` header of `@key value` lines).
 * - `<id>.user.css`: a UserCSS style, as for Stylus (a `/* ==UserStyle==`
 *   header, and `@-moz-document` blocks saying where each part applies).
 *
 * The file name is the mod's id.
 */
import type { ModFilter, ModRule } from "./match.js";

export type RunAt = "document_start" | "document_end" | "document_idle";

/** A mod as the extension registers it (see extension/userscripts.js). */
export type Mod = {
  /** The file name, e.g. `github-hide-sidebar.user.css`. */
  id: string;
  kind: "js" | "css";
  name: string;
  description?: string;
  version?: string;
  /** For grouping in Settings: the site it's for, or "All sites". */
  site: string;
  enabled: boolean;
  /** Set when the mod can't run; it is not registered. */
  error?: string;
  /** Things in the file Eyepatch doesn't support; the mod still runs. */
  warnings?: string[];
  /** Chrome match patterns to register with. Broader than `filter` when there is one. */
  matches: string[];
  excludeMatches: string[];
  /** The exact pages, when match patterns can't express them. Checked in the page. */
  filter?: ModFilter;
  runAt: RunAt;
  world: "isolated" | "main";
  allFrames: boolean;

  // .user.js
  js?: string;
  /** GM API functions the script may use, without the GM_/GM. prefix (e.g. "xmlhttpRequest"). */
  grants?: string[];
  /** Hosts GM_xmlhttpRequest may reach (`@connect`). */
  connects?: string[];
  requireUrls?: string[];
  resourceUrls?: Record<string, string>;
  /** Filled in by resolveAssets: the code of each @require, in order. */
  requires?: string[];
  /** Filled in by resolveAssets: each @resource, base64. */
  resources?: Record<string, { url: string; mimeType: string; base64: string }>;
  /** What GM_info reports. */
  info?: Record<string, unknown>;

  // .user.css
  sections?: { css: string; rules: ModRule[] }[];
};

export const JS_EXT = ".user.js";
export const CSS_EXT = ".user.css";
export const isModFile = (name: string) => name.endsWith(JS_EXT) || name.endsWith(CSS_EXT);

// ---------- metadata blocks ----------

export type Meta = {
  /** Every `@key value` line, in order. Keys keep their case. */
  entries: [string, string][];
  /** The header as written, for GM_info.scriptMetaStr. */
  raw: string;
  /** Where the header ends in the source. */
  end: number;
};

const first = (meta: Meta, key: string) => meta.entries.find(([k]) => k === key)?.[1];
const all = (meta: Meta, key: string) => meta.entries.filter(([k]) => k === key).map(([, v]) => v);

export function parseUserScriptMeta(src: string): Meta | null {
  const m = /^[ \t]*\/\/[ \t]*==UserScript==[ \t]*\r?\n([\s\S]*?)^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*$/m.exec(src);
  if (!m) return null;
  const entries: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const e = /^\s*\/\/\s*@([\w:.-]+)(?:\s+(.*?))?\s*$/.exec(line);
    if (e) entries.push([e[1], e[2] ?? ""]);
  }
  return { entries, raw: m[0], end: m.index + m[0].length };
}

export function parseUserCssMeta(src: string): Meta | null {
  const m = /\/\*\s*==UserStyle==[ \t]*\r?\n([\s\S]*?)==\/UserStyle==\s*\*\//.exec(src);
  if (!m) return null;
  const entries: [string, string][] = [];
  let pending: [string, string] | null = null;
  // A value can span lines while its brackets are open (e.g. a @var select's options).
  const open = (s: string) => (s.match(/[{[]/g)?.length ?? 0) - (s.match(/[}\]]/g)?.length ?? 0);
  for (const line of m[1].split(/\r?\n/)) {
    if (pending) {
      pending[1] += "\n" + line;
      if (open(pending[1]) <= 0) pending = null;
      continue;
    }
    const e = /^\s*@([\w:.-]+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!e) continue;
    const entry: [string, string] = [e[1], e[2] ?? ""];
    entries.push(entry);
    if (open(entry[1]) > 0) pending = entry;
  }
  return { entries, raw: m[0], end: m.index + m[0].length };
}

// ---------- shared helpers ----------

const CHROME_PATTERN = /^(\*|https?|file|ftp|wss?):\/\/(\*|\*\.[^/*:]+|[^/*:]*)(:\d+)?\/.*$/;
const BROAD = "*://*/*";

/** Tampermonkey accepts a few patterns Chrome doesn't; fix the ones we can. */
function normalizePattern(p: string) {
  let s = p.trim().replace(/^http\*:\/\//, "*://");
  if (/^[^:/]+:\/\/[^/]+$/.test(s)) s += "/*";
  return s;
}

/**
 * A Tampermonkey `@include` glob as a regex: `*` is anything, and `.tld`
 * stands for any top-level domain. Case-insensitive, matching the whole URL.
 */
function globRule(glob: string): ModRule {
  if (glob === "*") return { type: "all" };
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith(".tld", i) && (i + 4 === glob.length || "/:".includes(glob[i + 4]))) {
      src += "\\.(?:[a-z]{2,}|(?:com?|org|net|gov|ac|edu)\\.[a-z]{2})";
      i += 3;
      continue;
    }
    src += glob[i] === "*" ? ".*" : glob[i].replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
  }
  return { type: "regex", source: `^${src}$`, flags: "i" };
}

/** `@include` / `@exclude`: a `/regex/flags` or a glob. */
function includeRule(value: string): ModRule {
  const re = /^\/(.*)\/([a-z]*)$/.exec(value.trim());
  if (re) return { type: "regex", source: re[1], flags: re[2] };
  return globRule(value.trim());
}

/** `@match` / `@exclude-match`: a Chrome pattern, or the closest glob when Chrome won't take it. */
function matchRule(value: string): ModRule {
  const p = normalizePattern(value);
  const tld = /^[^:]+:\/\/[^/]*\.tld(:\d+)?\//.test(p);
  if (p === "<all_urls>" || (CHROME_PATTERN.test(p) && !tld)) return { type: "match", value: p };
  return globRule(p);
}

/** Match patterns that cover every page a rule can match. */
function patternsFor(rule: ModRule): string[] {
  switch (rule.type) {
    case "match":
      return [rule.value];
    case "domain": {
      const d = rule.value.toLowerCase();
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !/^[\d.]+$/.test(d)) return [`*://*.${d}/*`];
      return [`*://${d}/*`];
    }
    case "url":
    case "prefix": {
      // scheme://host/ followed by a literal path prefix narrows it; anything less is broad.
      const m = /^(https?|file):\/\/([^/?#*]*)(\/[^*#]*)?/.exec(rule.value);
      if (!m || (m[1] !== "file" && !m[2]) || (rule.type === "prefix" && m[3] === undefined)) return [BROAD];
      const host = m[2].replace(/:\d+$/, "");
      const path = (m[3] ?? "/").replace(/\?.*$/, "");
      return [`${m[1]}://${host}${path}*`];
    }
    default:
      return [BROAD];
  }
}

function registrationPatterns(rules: ModRule[]) {
  const out = new Set(rules.flatMap(patternsFor));
  if (out.has(BROAD) || out.has("<all_urls>")) {
    for (const p of [...out]) if (/^(\*|https?):\/\//.test(p) && p !== BROAD) out.delete(p);
  }
  return [...out];
}

/** The site to group a mod under in Settings. */
export function siteOf(rules: ModRule[]): string {
  const hosts = new Set<string>();
  for (const r of rules) {
    let host = "";
    if (r.type === "all") return "All sites";
    if (r.type === "domain") host = r.value;
    else if (r.type === "match") host = r.value === "<all_urls>" ? "*" : (/^[^:]+:\/\/([^/]*)/.exec(r.value)?.[1] ?? "");
    else if (r.type === "url" || r.type === "prefix") host = /^[^:]+:\/\/([^/?#]*)/.exec(r.value)?.[1] ?? "";
    else if (r.type === "regex") {
      // Best effort: the first thing that looks like a domain, after the scheme.
      const src = r.source.replace(/\\([./])/g, "$1");
      const m = /([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(src.includes("//") ? src.slice(src.indexOf("//") + 2) : src);
      host = m ? m[1] : "*";
    }
    host = host.toLowerCase().replace(/:\d+$/, "").replace(/^\*\./, "").replace(/^www\./, "");
    if (!host || host.includes("*")) return "All sites";
    hosts.add(host);
  }
  return [...hosts][0] ?? "All sites";
}

const baseName = (id: string) => id.replace(/\.user\.(js|css)$/, "");

// ---------- .user.js ----------

/** GM functions Eyepatch provides, by lowercased name without the prefix. */
const GM_FUNCTIONS: Record<string, string> = Object.fromEntries(
  [
    "getValue", "setValue", "deleteValue", "listValues", "getValues", "setValues", "deleteValues",
    "addValueChangeListener", "removeValueChangeListener",
    "addStyle", "addElement", "getResourceText", "getResourceURL",
    "xmlhttpRequest", "openInTab", "notification", "setClipboard",
    "registerMenuCommand", "unregisterMenuCommand", "log", "info",
  ].map((n) => [n.toLowerCase(), n]),
);
/** Ones that work without the extension, so also in the page's world. */
const LOCAL_FUNCTIONS = new Set(["addStyle", "addElement", "getResourceText", "getResourceURL", "setClipboard", "log", "info"]);
/** Grants that aren't GM functions and need nothing from us. */
const PLAIN_GRANTS = new Set(["none", "unsafewindow", "window.close", "window.focus", "window.onurlchange"]);

export function parseUserScript(id: string, src: string): Omit<Mod, "enabled"> {
  const base: Omit<Mod, "enabled"> = {
    id, kind: "js", name: baseName(id), site: "All sites", matches: [], excludeMatches: [],
    runAt: "document_idle", world: "isolated", allFrames: false,
  };
  const meta = parseUserScriptMeta(src);
  if (!meta) return { ...base, error: "missing the // ==UserScript== header" };

  const warnings: string[] = [];
  const name = first(meta, "name")?.trim() || base.name;

  // Which GM functions it may use.
  const grants = new Set<string>();
  const unsupported: string[] = [];
  for (const g of all(meta, "grant").flatMap((v) => v.split(/\s+/)).filter(Boolean)) {
    if (PLAIN_GRANTS.has(g.toLowerCase())) continue;
    const fn = GM_FUNCTIONS[g.replace(/^GM[._]/, "").toLowerCase()];
    if (fn && /^GM[._]/.test(g)) grants.add(fn);
    else unsupported.push(g);
  }
  if (unsupported.length) warnings.push(`unsupported @grant: ${unsupported.join(", ")}`);

  // Which world: the page's (sees its JS) or an isolated one (sees only the DOM).
  // As in Tampermonkey, a script that grants nothing runs in the page.
  const injectInto = first(meta, "inject-into")?.trim().toLowerCase();
  const sandbox = first(meta, "sandbox")?.trim().toLowerCase();
  let world: Mod["world"] = grants.size ? "isolated" : "main";
  if (injectInto === "page") world = "main";
  else if (injectInto === "content") world = "isolated";
  else if (sandbox === "raw" || sandbox === "javascript") world = "main";
  else if (sandbox === "dom") world = "isolated";
  const needsExtension = [...grants].filter((g) => !LOCAL_FUNCTIONS.has(g));
  if (world === "main" && needsExtension.length) {
    warnings.push(`GM_${needsExtension.join(", GM_")} can't work in the page's world (@inject-into page)`);
  }

  const runAtRaw = first(meta, "run-at")?.trim().toLowerCase();
  const runAt: RunAt =
    runAtRaw === "document-start" ? "document_start"
      : runAtRaw === "document-end" || runAtRaw === "document-body" ? "document_end"
        : "document_idle";
  if (runAtRaw && !["document-start", "document-end", "document-body", "document-idle"].includes(runAtRaw)) {
    warnings.push(`unsupported @run-at ${runAtRaw}`);
  }

  // Where it runs.
  const any = [...all(meta, "match").map(matchRule), ...all(meta, "include").map(includeRule)];
  const none = [...all(meta, "exclude-match").map(matchRule), ...all(meta, "exclude").map(includeRule)];
  const filtered = [...any, ...none].some((r) => r.type !== "match");
  const where = filtered
    ? { matches: registrationPatterns(any), excludeMatches: [], filter: { any, none } }
    : {
        matches: any.map((r) => (r as { value: string }).value),
        excludeMatches: none.map((r) => (r as { value: string }).value),
      };

  const resourceUrls: Record<string, string> = {};
  for (const v of all(meta, "resource")) {
    const m = /^(\S+)\s+(\S+)/.exec(v.trim());
    if (m) resourceUrls[m[1]] = m[2];
  }
  const requireUrls = all(meta, "require").map((v) => v.trim()).filter(Boolean);

  const mod: Omit<Mod, "enabled"> = {
    ...base,
    ...where,
    name,
    description: first(meta, "description")?.trim() || undefined,
    version: first(meta, "version")?.trim() || undefined,
    site: siteOf(any),
    runAt,
    world,
    allFrames: !meta.entries.some(([k]) => k === "noframes"),
    js: src,
    grants: [...grants],
    connects: all(meta, "connect").map((v) => v.trim().toLowerCase()).filter(Boolean),
    requireUrls,
    resourceUrls,
    info: {
      script: {
        name,
        namespace: first(meta, "namespace") ?? null,
        description: first(meta, "description") ?? null,
        version: first(meta, "version") ?? null,
        author: first(meta, "author") ?? null,
        matches: all(meta, "match"),
        includes: all(meta, "include"),
        excludes: all(meta, "exclude"),
        "exclude-match": all(meta, "exclude-match"),
        grant: all(meta, "grant"),
        require: requireUrls,
        resources: Object.entries(resourceUrls).map(([n, url]) => ({ name: n, url })),
        "run-at": runAtRaw ?? "document-idle",
        noframes: meta.entries.some(([k]) => k === "noframes"),
      },
      scriptMetaStr: meta.raw,
      scriptHandler: "Eyepatch",
      injectInto: world === "main" ? "page" : "content",
    },
    warnings: warnings.length ? warnings : undefined,
  };
  if (!any.length) return { ...mod, error: "needs at least one @match or @include" };
  return mod;
}

// ---------- .user.css ----------

/** CSS string contents, unescaped (`\\.` → `\.`, `\26` → `&`). */
function unescapeCss(s: string) {
  return s.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, g: string) =>
    /^[0-9a-fA-F]/.test(g) ? String.fromCodePoint(parseInt(g, 16)) : g,
  );
}

/** If a comment or string starts at `i`, the index just past it; otherwise -1. */
function skipNonCode(css: string, i: number): number {
  if (css[i] === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if (css[i] === '"' || css[i] === "'") {
    const q = css[i];
    let j = i + 1;
    while (j < css.length && css[j] !== q && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return -1;
}

/** Index of the next `ch` outside comments and strings, at bracket depth 0 relative to `from`. */
function findAtDepth0(css: string, from: number, ch: "{" | "}"): number {
  let depth = 0;
  for (let i = from; i < css.length; ) {
    const skip = skipNonCode(css, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const c = css[i];
    if (depth === 0 && c === ch) return i;
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return -1;
}

function documentRules(condition: string): ModRule[] {
  const rules: ModRule[] = [];
  const re = /(url-prefix|url|domain|regexp)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/g;
  for (const m of condition.matchAll(re)) {
    const value = m[4] !== undefined ? m[4].trim() : unescapeCss(m[2] ?? m[3] ?? "");
    if (m[1] === "url-prefix") rules.push({ type: "prefix", value });
    else if (m[1] === "url") rules.push({ type: "url", value });
    else if (m[1] === "domain") rules.push({ type: "domain", value });
    else rules.push({ type: "regex", source: `^(?:${value})$` });
  }
  return rules;
}

/** Split a stylesheet into its `@-moz-document` sections and the code around them (rules: []). */
export function splitSections(css: string): { css: string; rules: ModRule[] }[] {
  const out: { css: string; rules: ModRule[] }[] = [];
  let chunk = 0;
  let depth = 0;
  for (let i = 0; i < css.length; ) {
    const skip = skipNonCode(css, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    const c = css[i];
    const doc = depth === 0 && c === "@" ? /^@(?:-moz-)?document\b/i.exec(css.slice(i, i + 16)) : null;
    if (doc) {
      const open = findAtDepth0(css, i, "{");
      if (open < 0) break;
      const close = findAtDepth0(css, open + 1, "}");
      const end = close < 0 ? css.length : close;
      out.push({ css: css.slice(chunk, i), rules: [] });
      out.push({ css: css.slice(open + 1, end), rules: documentRules(css.slice(i + doc[0].length, open)) });
      i = chunk = end + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  out.push({ css: css.slice(chunk), rules: [] });
  // Code outside any section applies everywhere (as in Stylus), unless it's
  // only comments and @namespace/@charset.
  const meaningful = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(namespace|charset)\b[^;]*;/gi, "").trim() !== "";
  return out.filter((s) => (s.rules.length ? true : meaningful(s.css))).map((s) => ({ css: s.css.trim(), rules: s.rules }));
}

/** JSON, also with single quotes. */
function looseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(s.replace(/'/g, '"'));
  }
}

const unquote = (s: string) => {
  const t = s.trim();
  return /^(["']).*\1$/s.test(t) ? t.slice(1, -1) : t;
};

/** A `@var` default as a CSS custom property, or null if it can't be read. */
function varDeclaration(value: string): string | null {
  const m = /^(\S+)\s+(\S+)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)\s+([\s\S]*)$/.exec(value.trim());
  if (!m) return null;
  const [, type, name, , raw] = m;
  let v: string;
  try {
    switch (type) {
      case "text":
      case "color":
        v = unquote(raw);
        break;
      case "checkbox":
        v = unquote(raw) === "1" ? "1" : "0";
        break;
      case "number":
      case "range": {
        const parsed = raw.trim().startsWith("[") ? (looseJson(raw) as unknown[]) : [raw.trim()];
        const unit = parsed.find((x, i) => i > 0 && typeof x === "string" && !/^[\d.-]+$/.test(x)) ?? "";
        v = `${parsed[0]}${unit}`;
        break;
      }
      case "select":
      case "dropdown":
      case "image": {
        const opts = looseJson(raw);
        const pairs: [string, string][] = Array.isArray(opts)
          ? opts.map((o) => {
              const s = String(o);
              const [label, val] = s.includes("|") ? s.split("|") : [s, s.replace(/\*$/, "")];
              return [label, val.replace(/^[^:]*:/, (p) => (s.includes("|") ? "" : p))];
            })
          : Object.entries(opts as Record<string, unknown>).map(([k, val]) => [k, String(val)]);
        const chosen = pairs.find(([label]) => label.endsWith("*")) ?? pairs[0];
        if (!chosen) return null;
        v = chosen[1];
        break;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
  return `--${name}: ${v};`;
}

export function parseUserCss(id: string, src: string): Omit<Mod, "enabled"> {
  const base: Omit<Mod, "enabled"> = {
    id, kind: "css", name: baseName(id), site: "All sites", matches: [], excludeMatches: [],
    runAt: "document_start", world: "isolated", allFrames: true,
  };
  const meta = parseUserCssMeta(src);
  if (!meta) return { ...base, error: "missing the /* ==UserStyle== */ header" };
  const name = first(meta, "name")?.trim() || base.name;
  const pre = first(meta, "preprocessor")?.trim().toLowerCase();
  const described = { ...base, name, description: first(meta, "description")?.trim() || undefined, version: first(meta, "version")?.trim() || undefined };
  if (pre && pre !== "default") return { ...described, error: `the ${pre} preprocessor isn't supported; only plain CSS` };

  const warnings: string[] = [];
  const vars: string[] = [];
  for (const v of all(meta, "var")) {
    const decl = varDeclaration(v);
    if (decl) vars.push(decl);
    else warnings.push(`couldn't read @var ${v.split(/\s+/)[1] ?? v}`);
  }
  if (meta.entries.some(([k]) => k === "advanced")) warnings.push("@advanced isn't supported; use @var");

  const body = src.slice(0, meta.end - meta.raw.length) + src.slice(meta.end);
  const varsCss = vars.length ? `:root {\n  ${vars.join("\n  ")}\n}\n` : "";
  const sections = splitSections(body).map((s) => ({ css: varsCss + s.css, rules: s.rules }));
  const any: ModRule[] = sections.flatMap((s) => (s.rules.length ? s.rules : [{ type: "all" as const }]));

  const mod: Omit<Mod, "enabled"> = {
    ...described,
    site: siteOf(any),
    matches: registrationPatterns(any),
    excludeMatches: [],
    filter: { any, none: [] },
    sections,
    warnings: warnings.length ? warnings : undefined,
  };
  if (!sections.length) return { ...mod, error: "has no CSS" };
  return mod;
}

export function parseModFile(id: string, src: string): Omit<Mod, "enabled"> {
  return id.endsWith(CSS_EXT) ? parseUserCss(id, src) : parseUserScript(id, src);
}

// ---------- converting old-format mods ----------

/** A match pattern as a UserCSS `@-moz-document` condition, exactly. */
export function patternToDocumentRule(p: string): string {
  if (p === "<all_urls>") return `regexp(${JSON.stringify("(https?|file|ftp)://.*")})`;
  const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/.exec(p);
  if (!m) return `url(${JSON.stringify(p)})`;
  const [, scheme, host, path] = m;
  const schemes = scheme === "*" ? ["http", "https"] : [scheme];
  // Match patterns ignore ports; url-prefix() doesn't. Ports are usual on
  // local hosts, so those get a regexp that allows one.
  const local = /^(localhost|[\d.]+|\[[\da-f:]+\])$/i.test(host) || !host.includes(".");
  const literalHost = !host.includes("*") && !host.includes(":") && !local;
  const prefixPath = /^\/[^*]*\*$/.test(path) ? path.slice(0, -1) : null;
  if (host.startsWith("*.") && !host.slice(2).includes("*") && path === "/*" && scheme === "*") return `domain(${JSON.stringify(host.slice(2))})`;
  if (literalHost && prefixPath !== null) return schemes.map((s) => `url-prefix(${JSON.stringify(`${s}://${host}${prefixPath}`)})`).join(", ");
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const hostRe = host === "*" ? "[^/]*" : host.startsWith("*.") ? `([^/]*\\.)?${esc(host.slice(2))}` : esc(host.replace(/:\d+$/, ""));
  const pathRe = path.split("*").map(esc).join(".*");
  const schemeRe = scheme === "*" ? "https?" : esc(scheme);
  // The CSS string escaping doubles each backslash.
  return `regexp(${JSON.stringify(`${schemeRe}://${hostRe}(:\\d+)?${pathRe}(#.*)?`)})`;
}

type LegacyMeta = {
  name: string;
  description?: string;
  matches: string[];
  excludeMatches?: string[];
  runAt: RunAt;
  world: "isolated" | "main";
};

/** An old `<id>/mod.json` + `mod.css` + `mod.js` mod as one new-format file. */
export function convertLegacyMod(meta: LegacyMeta, css?: string, js?: string): { ext: string; content: string } {
  const header = (lines: [string, string][]) => {
    const w = Math.max(...lines.map(([k]) => k.length)) + 1;
    return lines.map(([k, v]) => `@${k.padEnd(w)}${v}`.trimEnd());
  };
  const desc: [string, string][] = meta.description ? [["description", meta.description]] : [];

  if (!js && !meta.excludeMatches?.length) {
    const lines = header([["name", meta.name], ...desc, ["version", "1.0.0"]]);
    const conditions = meta.matches.map(patternToDocumentRule).join(",\n               ");
    const body = (css ?? "").trim().replace(/^/gm, "  ");
    return {
      ext: CSS_EXT,
      content: `/* ==UserStyle==\n${lines.join("\n")}\n==/UserStyle== */\n\n@-moz-document ${conditions} {\n${body}\n}\n`,
    };
  }

  const lines = header([
    ["name", meta.name],
    ...desc,
    ["version", "1.0.0"],
    ...meta.matches.map((m): [string, string] => ["match", m]),
    ...(meta.excludeMatches ?? []).map((m): [string, string] => ["exclude-match", m]),
    ["run-at", meta.runAt.replace("_", "-")],
    ["inject-into", meta.world === "main" ? "page" : "content"],
    ["grant", css ? "GM_addStyle" : "none"],
    ["noframes", ""],
  ]);
  const style = css ? `GM_addStyle(\`\n${css.trim().replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${")}\n\`);\n\n` : "";
  return {
    ext: JS_EXT,
    content: `// ==UserScript==\n${lines.map((l) => `// ${l}`).join("\n")}\n// ==/UserScript==\n\n${style}${(js ?? "").trim()}\n`,
  };
}
