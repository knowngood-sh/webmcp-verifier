/**
 * webmcp.js — the WebMCP checker. LAYER 1: static declaration.
 *
 * WHAT THIS MODULE MAY TOUCH, AND WHAT IT MAY NOT.
 *
 * It takes a URL and a fetch, and returns a verdict. It has NO access to D1,
 * to the index, or to anything we hold about a host. That is a boundary, not
 * a convenience: a checker that leaked whether our index knows a host —
 * including by answering faster, or differently, for hosts we hold — would
 * break the byte-identical rule get_site_report is built on. The only other
 * input is the published population figures, which are public already.
 *
 * THREE STATES, AND THE THIRD IS THE PRODUCT.
 *
 *   DECLARED       the registration code is in the page or its first-party JS
 *   NOT_DECLARED   we fetched everything we meant to and it is not there
 *   COULD_NOT_ASK  we could not complete the check
 *   EXCLUDED       the host's robots.txt says ai-input=no
 *
 * A check that cannot distinguish "no" from "couldn't ask" must not report
 * "no". Every other WebMCP checker collapses those two, and the collapse is
 * always in the same direction — toward a confident negative. Reporting
 * COULD_NOT_ASK honestly is the whole differentiator.
 *
 * EXCLUDED IS NOT A FAILURE AND IS NEVER SILENT. A host that refuses AI input
 * is reported as excluded, with the reason, and never as failing a check we
 * did not run. Nor is it omitted: omission would let a caller infer refusal
 * from absence, which is the same disclosure by a quieter route.
 */

/** Never disguised. A host that wants us gone can name us in robots.txt. */
export const VERIFIER_UA =
  "KnownGood-Verifier/1.0 (+https://knowngood.sh/bot; webmcp-check)";

export const VERDICT = {
  DECLARED: "declared",
  NOT_DECLARED: "not_declared",
  COULD_NOT_ASK: "could_not_ask",
  EXCLUDED: "excluded",
};

/* --------------------------------------------------------------- consent */

/**
 * Content-Signal `ai-input`, read from the group that applies to us.
 *
 * Returns "no" | "yes" | "unset". Only "no" stops the check — an absent
 * signal is an absent signal, not consent and not refusal, and we treat it
 * the way the published bot policy does.
 */
export function aiInputStance(robotsTxt, ua = "KnownGood-Verifier") {
  if (!robotsTxt) return "unset";
  const lines = String(robotsTxt).split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  let applies = false, sawGroup = false, stance = "unset";
  for (const line of lines) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (sawGroup && applies) break;           // the group that matched us has ended
      sawGroup = true;
      const v = val.toLowerCase();
      applies = v === "*" || ua.toLowerCase().includes(v) || v.includes(ua.toLowerCase());
      continue;
    }
    if (!applies) continue;
    if (key === "content-signal") {
      const s = /ai-input\s*=\s*([a-z]+)/i.exec(val);
      if (s) stance = s[1].toLowerCase();
    }
  }
  return stance;
}

/** Disallow rules for the group that applies to us. Longest match wins, and
 *  an equally specific Allow beats Disallow, per RFC 9309. */
export function pathAllowed(robotsTxt, path, ua = "KnownGood-Verifier") {
  if (!robotsTxt) return true;
  const lines = String(robotsTxt).split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  let applies = false, best = null;
  for (const line of lines) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      const v = val.toLowerCase();
      applies = v === "*" || ua.toLowerCase().includes(v) || v.includes(ua.toLowerCase());
      continue;
    }
    if (!applies || (key !== "allow" && key !== "disallow")) continue;
    if (val === "") continue;                    // "Disallow:" with no value allows all
    const rule = val.replace(/\*+/g, "");        // crude prefix match; wildcards widen
    if (!path.startsWith(rule.split("$")[0])) continue;
    if (!best || rule.length > best.len || (rule.length === best.len && key === "allow"))
      best = { len: rule.length, allow: key === "allow" };
  }
  return best ? best.allow : true;
}

/* ------------------------------------------------------------- detection */

/**
 * WHAT COUNTS AS A DECLARATION, AND WHY IT IS A CALL SHAPE.
 *
 * The brief's own caution: "pages about WebMCP will false-positive". At crawl
 * volumes that is hand-reviewed; a live checker cannot hand-review, so the
 * patterns require a CALL or a MEMBER ACCESS, never a bare word. The string
 * "provideContext" in prose does not match; `provideContext(` does.
 *
 * BOTH ENTRY POINTS. The July 2026 draft renamed `navigator.modelContext` to
 * `document.modelContext` mid-origin-trial. A checker that knows only one is
 * wrong for half the corpus depending on when the page was written, and the
 * spec is still moving — so both are matched and the matched form is reported,
 * because which one a page uses is itself a dated fact worth returning.
 */
export const WEBMCP_PATTERNS = [
  { id: "navigator.modelContext", re: /\bnavigator\s*\.\s*modelContext\b/ },
  { id: "document.modelContext", re: /\bdocument\s*\.\s*modelContext\b/ },
  { id: "provideContext()", re: /\bprovideContext\s*\(/ },
  { id: "registerTool()", re: /\bregisterTool\s*\(/ },
  { id: "unregisterTool()", re: /\bunregisterTool\s*\(/ },
];

/** Matches with a short quotation, so a caller can see WHY it matched. */
export function detectStatic(source, label = "") {
  const s = String(source || "");
  const out = [];
  for (const p of WEBMCP_PATTERNS) {
    const m = p.re.exec(s);
    if (!m) continue;
    const at = m.index;
    out.push({
      pattern: p.id,
      where: label,
      // evidence, not proof: enough context for a human to judge a false positive
      context: s.slice(Math.max(0, at - 40), at + 60).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/** Same-origin script URLs, in document order, capped. */
export function firstPartyScripts(html, pageUrl, cap = 5) {
  const base = new URL(pageUrl);
  const out = [];
  for (const m of String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (u.origin !== base.origin) continue;      // first-party only, per the brief
    if (!out.includes(u.href)) out.push(u.href);
    if (out.length >= cap) break;
  }
  return out;
}

/* ------------------------------------------------------------- the check */

const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

/** One fetch, with our UA, a timeout, and a byte cap. Never throws. */
async function get(url, fetchImpl, signalMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), signalMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": VERIFIER_UA, accept: "text/html,application/javascript,*/*" },
      redirect: "follow", signal: ctl.signal,
    });
    // Retry-After is honoured by REFUSING, not by sleeping: a checker that
    // sleeps inside a request holds a connection open on someone else's
    // rate limit. The caller is told to come back.
    if (res.status === 429 || res.status === 503) {
      return { ok: false, status: res.status, retryAfter: res.headers.get("retry-after") || null };
    }
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.text()).slice(0, MAX_BYTES);
    return { ok: true, status: res.status, body, url: res.url || url,
             type: res.headers.get("content-type") || "" };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.name === "AbortError") ? "timeout" : "network" };
  } finally { clearTimeout(t); }
}

/**
 * Check one URL for a WebMCP declaration.
 *
 * ORDER IS THE CONSENT RULE: robots.txt is read BEFORE the resource request,
 * every time, and a failure to read it is not consent — it leaves the stance
 * unset, which is what it is.
 */
export async function checkWebmcp(input, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const checked_at = now().toISOString();
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { verdict: VERDICT.COULD_NOT_ASK, reason: "not a valid URL", input, checked_at };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { verdict: VERDICT.COULD_NOT_ASK, reason: "unsupported scheme", input, checked_at };

  const host = url.host;
  const base = { host, url: url.href, checked_at, user_agent: VERIFIER_UA };

  /* 1 — consent, before anything else is requested */
  const robots = await get(new URL("/robots.txt", url).href, fetchImpl, 5000);
  const robotsTxt = robots.ok ? robots.body : "";
  const stance = aiInputStance(robotsTxt);
  if (stance === "no")
    return { ...base, verdict: VERDICT.EXCLUDED, reason: "ai-input=no in robots.txt",
             robots_read: true,
             note: "Reported as excluded, never as failing. We did not request the page." };
  if (robots.ok && !pathAllowed(robotsTxt, url.pathname))
    return { ...base, verdict: VERDICT.EXCLUDED, reason: "robots.txt disallows this path for our agent",
             robots_read: true,
             note: "Reported as excluded, never as failing. We did not request the page." };
  if (robots.retryAfter)
    return { ...base, verdict: VERDICT.COULD_NOT_ASK, robots_read: false,
             reason: `robots.txt rate-limited us (${robots.status})`, retry_after: robots.retryAfter };

  /* 2 — the page */
  const page = await get(url.href, fetchImpl);
  if (!page.ok)
    return { ...base, verdict: VERDICT.COULD_NOT_ASK, robots_read: robots.ok,
             reason: page.retryAfter ? `rate-limited (${page.status})`
                   : page.status ? `HTTP ${page.status}` : (page.error || "fetch failed"),
             ...(page.retryAfter ? { retry_after: page.retryAfter } : {}) };
  if (!/text\/html|application\/xhtml/i.test(page.type) && !/<html/i.test(page.body))
    return { ...base, verdict: VERDICT.COULD_NOT_ASK, robots_read: robots.ok,
             reason: `not an HTML page (${page.type || "unknown content-type"})` };

  const evidence = detectStatic(page.body, "page HTML");

  /* 3 — first-party scripts. WebMCP registration is JS, and most sites ship
   *     it in a bundle, so an HTML-only check would report NOT_DECLARED for
   *     sites that declare. Each fetch is counted and reported, because the
   *     check has its own denominator and hiding it would be the defect this
   *     product exists to name. */
  const scripts = firstPartyScripts(page.body, page.url);
  const fetched = [];
  let skipped = 0;
  for (const s of scripts) {
    // consent beats completeness: a script robots.txt disallows is not read.
    // But it is COUNTED, because the declaration could be in it — declining to
    // look is a reason we could not ask, not evidence of absence.
    if (!pathAllowed(robotsTxt, new URL(s).pathname)) { skipped++; continue; }
    const js = await get(s, fetchImpl, 6000);
    fetched.push({ url: s, ok: js.ok, status: js.status });
    if (js.ok) evidence.push(...detectStatic(js.body, s));
  }
  const unread = fetched.filter((f) => !f.ok).length;

  if (evidence.length)
    return { ...base, verdict: VERDICT.DECLARED, robots_read: robots.ok, evidence,
             scripts_found: scripts.length, scripts_fetched: fetched.length,
             note: "Declared means the registration code is present. It does not mean a " +
                   "tool registers when the page runs — that needs a browser." };

  /* NOT_DECLARED requires that we actually read everything we meant to. If a
   * script we intended to read did not come back, we could not ask. */
  if (unread || skipped)
    return { ...base, verdict: VERDICT.COULD_NOT_ASK, robots_read: robots.ok,
             reason: unread
               ? `${unread} of ${fetched.length} first-party scripts could not be read`
               : `${skipped} first-party script(s) are disallowed by robots.txt, and the ` +
                 `declaration could be in one of them`,
             scripts_found: scripts.length, scripts_fetched: fetched.length,
             scripts_skipped_by_robots: skipped };

  return { ...base, verdict: VERDICT.NOT_DECLARED, robots_read: robots.ok, evidence: [],
           scripts_found: scripts.length, scripts_fetched: fetched.length,
           scripts_skipped_by_robots: 0,
           note: scripts.length > 5
             ? `Only the first ${fetched.length} same-origin scripts were read; a declaration in a later bundle would be missed.`
             : "The page and all its first-party scripts were read." };
}
