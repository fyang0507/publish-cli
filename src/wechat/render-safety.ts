/** URL and raw-HTML preflight checks shared by WeChat article rendering. */
import { marked, type Token, type Tokens } from "marked";
import { LocalValidationError } from "../capabilities/validation.js";

/** WeChat's own article domain — links here are always kept inline (never cited). */
const WECHAT_HOST = "mp.weixin.qq.com";

/** HTML-escape text content (`&`, `<`, `>`). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML-escape an attribute value (adds `"`). */
export function escapeHtmlAttribute(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

type WechatUrlUsage = "link" | "image" | "source";
type SafeWechatUrlKind = "http" | "https" | "mailto" | "relative" | "fragment";

interface WechatUrlInspection {
  canonical: string;
  kind: SafeWechatUrlKind | null;
  problem:
    | "control_character"
    | "excessive_encoding"
    | "malformed_encoding"
    | "scheme_relative"
    | "invalid"
    | "unsupported_scheme"
    | null;
  actual: string;
}

const URL_NAMED_ENTITY: Readonly<Record<string, string>> = {
  amp: "&",
  bsol: "\\",
  colon: ":",
  newline: "\n",
  sol: "/",
  tab: "\t",
};

const REPORTABLE_URL_SCHEMES = new Set([
  "data",
  "file",
  "http",
  "https",
  "javascript",
  "mailto",
  "vbscript",
]);

/** Keep caller-controlled error evidence bounded and avoid echoing arbitrary schemes. */
function reportedUrlScheme(scheme: string): string {
  return REPORTABLE_URL_SCHEMES.has(scheme) ? scheme : "unsupported_scheme";
}

/** Decode one entity/percent layer for the rejection probe, using strict UTF-8. */
function decodeUrlProbeStep(value: string): { value: string; malformed: boolean } {
  const entitiesDecoded = value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (whole, hex: string | undefined, dec: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? dec ?? "", hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    })
    .replace(/&(amp|bsol|colon|newline|sol|tab);/gi, (whole, name: string) =>
      URL_NAMED_ENTITY[name.toLowerCase()] ?? whole);
  try {
    // Unlike byte-wise String.fromCharCode decoding, decodeURIComponent treats
    // percent triplets as UTF-8: encoded CJK/punctuation remain valid Unicode,
    // while lone continuation bytes, truncated sequences, and malformed `%`
    // syntax fail closed instead of masquerading as C1 controls.
    return { value: decodeURIComponent(entitiesDecoded), malformed: false };
  } catch {
    return { value: entitiesDecoded, malformed: true };
  }
}

/**
 * Repeated decoding closes entity/percent nesting tricks without letting hostile
 * input force an unbounded loop. More than eight changing layers is rejected as
 * ambiguous rather than treated as a relative URL.
 */
function canonicalizeUrlForSafety(raw: string): {
  value: string;
  excessive: boolean;
  malformed: boolean;
} {
  let value = raw.trim();
  for (let i = 0; i < 8; i += 1) {
    const decoded = decodeUrlProbeStep(value);
    if (decoded.malformed) {
      // Malformed percent/UTF-8 in the caller's raw value is invalid. After at
      // least one valid layer, however, an unmatched percent can be the decoded
      // literal represented by `%25` (for example `./100%25-complete`). Stop at
      // that derived text and still run every scheme/control/network/colon probe
      // below; do not misclassify the valid emitted encoding as malformed.
      return i === 0
        ? { value: decoded.value, excessive: false, malformed: true }
        : { value, excessive: false, malformed: false };
    }
    if (decoded.value === value) return { value, excessive: false, malformed: false };
    value = decoded.value;
  }
  const next = decodeUrlProbeStep(value);
  return {
    value,
    excessive: !next.malformed && next.value !== value,
    // This is necessarily a derived ninth-layer value; a malformed next decode
    // means the current terminal percent came from a valid earlier `%25` layer.
    malformed: false,
  };
}

/** Classify a URL/path after security canonicalization; this function never throws. */
export function inspectWechatUrl(raw: string, usage: WechatUrlUsage): WechatUrlInspection {
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  if (controls.test(raw)) {
    return { canonical: "", kind: null, problem: "control_character", actual: "control_character" };
  }
  const emitted = raw.trim();
  if (raw !== emitted) {
    return { canonical: emitted, kind: null, problem: "invalid", actual: "surrounding_whitespace" };
  }
  if (/^[\\/]{2}/.test(emitted)) {
    return { canonical: emitted, kind: null, problem: "scheme_relative", actual: "scheme_relative" };
  }
  // A drive-absolute Windows body-image path is a local asset, not a URI
  // scheme. It still goes through the normal local-file validation below.
  // Double-leading UNC/network paths were rejected immediately above.
  if (usage === "image" && /^[a-z]:[\\/]/i.test(emitted)) {
    return { canonical: emitted, kind: "relative", problem: null, actual: "relative" };
  }

  if (emitted.startsWith("#")) {
    return usage === "link"
      ? { canonical: emitted, kind: "fragment", problem: null, actual: "fragment" }
      : { canonical: emitted, kind: null, problem: "unsupported_scheme", actual: "fragment" };
  }
  const directMatch = /^([a-z][a-z0-9+.-]*):/i.exec(emitted);
  const directScheme = directMatch?.[1].toLowerCase() ?? null;

  // An explicit scheme is evaluated against the exact emitted value. Decoding
  // must never repair an invalid absolute URL or grant it a safe classification.
  if (directScheme) {
    const decodedOnce = decodeUrlProbeStep(emitted);
    if (decodedOnce.malformed) {
      return { canonical: emitted, kind: null, problem: "malformed_encoding", actual: "malformed_encoding" };
    }
    if (controls.test(decodedOnce.value)) {
      return { canonical: emitted, kind: null, problem: "control_character", actual: "control_character" };
    }
    if (directScheme === "mailto") {
      if (usage !== "link" || !emitted.slice(directMatch?.[0].length ?? 0).trim()) {
        return { canonical: emitted, kind: null, problem: "unsupported_scheme", actual: directScheme };
      }
      try {
        if (new URL(emitted).protocol.toLowerCase() !== "mailto:") throw new Error("invalid mailto");
      } catch {
        return { canonical: emitted, kind: null, problem: "invalid", actual: "mailto:invalid" };
      }
      return { canonical: emitted, kind: "mailto", problem: null, actual: directScheme };
    }
    if (directScheme !== "http" && directScheme !== "https") {
      return {
        canonical: emitted,
        kind: null,
        problem: "unsupported_scheme",
        actual: reportedUrlScheme(directScheme),
      };
    }
    // WHATWG URL parsing deliberately repairs inputs such as http:///host and
    // treats backslashes as path separators for special schemes. Those bytes
    // are not the explicit `http(s)://authority` form we promise to emit, so
    // reject them before parsing instead of approving a normalized surrogate.
    if (!/^https?:\/\/[^/?#\\]/i.test(emitted) || emitted.includes("\\")) {
      return { canonical: emitted, kind: null, problem: "invalid", actual: `${directScheme}:invalid` };
    }
    const authority = emitted.slice(emitted.indexOf("://") + 3).split(/[/?#]/, 1)[0];
    if (authority.includes("@")) {
      return { canonical: emitted, kind: null, problem: "invalid", actual: "credentials_unsupported" };
    }
    try {
      const parsed = new URL(emitted);
      if (parsed.protocol.toLowerCase() !== `${directScheme}:` || !parsed.hostname) {
        return { canonical: emitted, kind: null, problem: "invalid", actual: `${directScheme}:invalid` };
      }
    } catch {
      return { canonical: emitted, kind: null, problem: "invalid", actual: `${directScheme}:invalid` };
    }
    return { canonical: emitted, kind: directScheme, problem: null, actual: directScheme };
  }

  // With no explicit scheme, recursively decode only as a rejection probe for
  // an encoded/obfuscated scheme, control byte, fragment, or network-path form.
  const decoded = canonicalizeUrlForSafety(emitted);
  const canonical = decoded.value.trim();
  if (decoded.malformed) {
    return { canonical, kind: null, problem: "malformed_encoding", actual: "malformed_encoding" };
  }
  if (decoded.excessive) {
    return { canonical, kind: null, problem: "excessive_encoding", actual: "excessive_encoding" };
  }
  if (controls.test(canonical)) {
    return { canonical, kind: null, problem: "control_character", actual: "control_character" };
  }
  if (/^[\\/]{2}/.test(canonical)) {
    return { canonical, kind: null, problem: "scheme_relative", actual: "scheme_relative" };
  }
  if (canonical.startsWith("#")) {
    return { canonical, kind: null, problem: "unsupported_scheme", actual: "obfuscated_url" };
  }

  const canonicalColon = canonical.indexOf(":");
  const canonicalPrefix = canonicalColon < 0 ? "" : canonical.slice(0, canonicalColon);
  const compactCanonicalPrefix = canonicalPrefix.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  const canonicalScheme = /^[a-z][a-z0-9+.-]*$/i.test(compactCanonicalPrefix)
    ? compactCanonicalPrefix.toLowerCase()
    : null;
  if (canonicalScheme) {
    if (canonicalScheme !== "http" && canonicalScheme !== "https" && canonicalScheme !== "mailto") {
      return {
        canonical,
        kind: null,
        problem: "unsupported_scheme",
        actual: reportedUrlScheme(canonicalScheme),
      };
    }
    return { canonical, kind: null, problem: "unsupported_scheme", actual: "obfuscated_scheme" };
  }

  // A colon in the first path segment is neither an ordinary relative path nor
  // a syntactically valid explicit scheme (e.g. java\\script: or a format-char
  // smuggling attempt), so fail closed.
  const firstColon = emitted.indexOf(":");
  const firstPathSeparator = emitted.search(/[/?#]/);
  if (firstColon >= 0 && (firstPathSeparator < 0 || firstColon < firstPathSeparator)) {
    return { canonical, kind: null, problem: "invalid", actual: "malformed_scheme" };
  }
  if (usage === "source" || (usage === "image" && !emitted)) {
    return { canonical, kind: null, problem: "invalid", actual: emitted ? "relative" : "empty" };
  }
  return { canonical: emitted, kind: "relative", problem: null, actual: "relative" };
}

function urlExpected(usage: WechatUrlUsage): string {
  if (usage === "source") return "an absolute http:// or https:// URL";
  if (usage === "image") return "an http(s) URL or local filesystem path (not a fragment or scheme-relative URL)";
  return "http, https, mailto, a relative URL, or a fragment";
}

/** Reject one caller URL with structured, bounded actual/expected evidence. */
export function assertSafeWechatUrl(raw: string, usage: WechatUrlUsage): WechatUrlInspection {
  const inspected = inspectWechatUrl(raw, usage);
  if (!inspected.problem) return inspected;
  const label = usage === "source" ? "source URL" : `Markdown ${usage} destination`;
  const expected = urlExpected(usage);
  throw new LocalValidationError(
    `Unsafe or unsupported WeChat ${label} (actual: ${inspected.actual}; expected: ${expected}).`,
    {
      code: usage === "source" ? "wechat_source_url_unsafe" : "wechat_url_unsafe",
      field: usage === "source" ? "source" : "body",
      actual: inspected.actual,
      expected,
      unit: null,
    },
  );
}

/** Validate every nested Marked token before rendering or reading any asset. */
export function assertSafeWechatTokens(tokens: Token[]): void {
  marked.walkTokens(tokens, (token) => {
    if (token.type === "html") {
      throw new LocalValidationError(
        "Raw HTML is unsupported in WeChat Markdown (actual: raw_html; expected: Markdown syntax, escaped HTML text, or code).",
        {
          code: "wechat_raw_html_unsupported",
          field: "body",
          actual: "raw_html",
          expected: "Markdown syntax, escaped HTML text, or code",
          unit: null,
        },
      );
    }
    if (token.type === "link") {
      assertSafeWechatUrl((token as Tokens.Link).href ?? "", "link");
    } else if (token.type === "image") {
      assertSafeWechatUrl((token as Tokens.Image).href ?? "", "image");
    }
  });
}

/** Is this a WeChat-native (mp.weixin.qq.com) link (always kept inline)? */
export function isWeChatLink(href: string): boolean {
  const inspected = inspectWechatUrl(href, "link");
  if (inspected.problem || (inspected.kind !== "http" && inspected.kind !== "https")) return false;
  try {
    return new URL(inspected.canonical).hostname.toLowerCase() === WECHAT_HOST;
  } catch {
    return false;
  }
}
