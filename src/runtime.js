/**
 * runtime.js — LAYER 2: does a tool actually register when the page runs?
 *
 * WHY THE LAYERS ARE SEPARATE. Layer 1 proves a registration EXISTS in the
 * source. It cannot prove anything registers: a script that throws, is gated
 * behind consent, or never runs registers nothing. Our own full-index pass
 * found 647 hosts carrying the code and 580 registering — 67 declared and
 * delivered nothing. Reporting layer 1 as "has WebMCP" would reproduce
 * exactly the error this index exists to correct on other people's data.
 *
 * TOOLS ARE ENUMERATED, NEVER INVOKED. The page is executed with a
 * modelContext supplied and we record what it hands us. Calling a stranger's
 * tool could place an order, send a message, or change state on a site that
 * never agreed to it — the same rule as tools/list on a remote MCP server,
 * and it is not negotiable for a checker anyone can point at any host.
 *
 * AVAILABILITY IS A FIRST-CLASS STATE. Browser Rendering has a two-concurrent
 * ceiling, two new browsers per minute per account, and a 60s inactivity
 * kill. When it is unavailable, busy, or unentitled, this returns
 * COULD_NOT_ASK with the reason — never a negative. That is the same rule as
 * layer 1 and the reason the product is worth using.
 */
import { VERDICT, VERIFIER_UA } from "./webmcp.js";

/** The shim installed before any page script runs. It RECORDS and never
 *  calls: registerTool and provideContext capture names and return, so a page
 *  that registers behaves normally and nothing it exposes is executed. */
export const PROBE_SCRIPT = `(() => {
  const names = [];
  const record = (t) => { try { if (t && (t.name || t.id)) names.push(String(t.name || t.id)); } catch (e) {} };
  const ctx = {
    registerTool(t) { record(t); return true; },
    unregisterTool() { return true; },
    provideContext(c) { try { (c && c.tools || []).forEach(record); } catch (e) {} return true; },
    listTools() { return names.slice(); },
  };
  try { Object.defineProperty(navigator, "modelContext", { value: ctx, configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, "modelContext", { value: ctx, configurable: true }); } catch (e) {}
  window.__kg_tools = names;
})();`;

/**
 * The wait we quote when the runtime layer is busy.
 *
 * Browser Rendering allows two NEW browsers per minute per account, so a
 * caller who arrives at a full ceiling waits on average half that window
 * before a slot can be created. 30 seconds is that number and not a guess —
 * and it is quoted as "about", because the queue ahead of them is not
 * something we can see.
 */
export const BUSY_RETRY_SECONDS = 30;

export const UNAVAILABLE = {
  NO_BINDING: "browser rendering is not configured on this deployment",
  NOT_ENTITLED: "browser rendering is not enabled for this account or token",
  BUSY: "browser rendering is at its concurrency limit",
  TIMEOUT: "the page did not settle within the time we allow",
  FAILED: "the browser could not load the page",
};

/**
 * Enumerate registered tools. `openPage` is injected so this module has no
 * hard dependency on a binding that may not exist — which is also what makes
 * the unavailable path testable rather than merely asserted.
 *
 * Returns { ok, tools } or { ok: false, reason }.
 */
export async function enumerateTools(url, { openPage, timeoutMs = 20000 } = {}) {
  if (typeof openPage !== "function") return { ok: false, reason: UNAVAILABLE.NO_BINDING };
  let page;
  try {
    page = await openPage();
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false,
      reason: /concurren|limit|429|too many/i.test(msg) ? UNAVAILABLE.BUSY
            : /auth|entitle|403|401/i.test(msg) ? UNAVAILABLE.NOT_ENTITLED
            : UNAVAILABLE.FAILED };
  }
  try {
    await page.setUserAgent(VERIFIER_UA);
    await page.evaluateOnNewDocument(PROBE_SCRIPT);
    await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs });
    // This closure is serialised into the PAGE and runs in the browser, where
    // `window` exists. It is not worker code, which is why eslint cannot see it.
    // eslint-disable-next-line no-undef
    const tools = await page.evaluate(() => (window.__kg_tools || []).slice());
    return { ok: true, tools: [...new Set(tools.filter(Boolean))] };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, reason: /timeout|deadline/i.test(msg) ? UNAVAILABLE.TIMEOUT : UNAVAILABLE.FAILED };
  } finally {
    try { await page.close(); } catch (e) { /* a close failure must not mask the result */ }
  }
}

/**
 * A fetch, backed by a real browser navigation.
 *
 * WHY THIS EXISTS. A Cloudflare Worker cannot make a subrequest to a hostname
 * its own script serves — Cloudflare refuses the loop and surfaces HTTP 522.
 * So this checker could reach every site on the web except the one it runs
 * on, and the one it runs on is the first a reader will try. Browser
 * Rendering is a separate service and is NOT subject to that block: it loads
 * our own origin normally, which is what makes a genuine self-check possible.
 *
 * IT IS THE SAME CHECK, NOT A SUBSTITUTE FOR ONE. The bytes still come from
 * the live host over the network, with our user agent, and robots.txt is
 * still read before the page. Only the transport changes. Nothing here reads
 * local state, and no verdict is ever synthesised from what we know about
 * ourselves — that would make the one claim this product rests on worthless.
 *
 * Shaped as the subset of Response that webmcp.js actually uses, so the core
 * is unchanged and stays transport-agnostic.
 */
export function browserFetch(page, { timeoutMs = 15000 } = {}) {
  // The origin of the document currently loaded, which is NOT always the
  // origin we asked for: www.knowngood.sh 301s to the apex, so after the
  // first navigation the document sits on knowngood.sh and an in-page fetch
  // of the www URL is cross-origin and dies in CORS. Track where we actually
  // ARE, not where we aimed.
  let docOrigin = null;
  return async (url, opts = {}) => {
    const ua = (opts.headers && opts.headers["user-agent"]) || VERIFIER_UA;
    await page.setUserAgent(ua);

    /* The FIRST call navigates. It is always robots.txt — consent is read
     * before anything else is requested, and that ordering is the point — and
     * a text file navigates cleanly. It also gives us a document on the
     * target's origin, which is what the branch below needs.
     *
     * EVERY LATER CALL IS FETCHED FROM INSIDE THAT DOCUMENT. Navigating a
     * browser to a .js URL does not render it, it downloads it, and the
     * navigation aborts — which is exactly how this first failed: robots.txt
     * and the page read fine and every first-party script came back
     * unreadable, so a site that declares in a bundle looked like a site we
     * could not ask about. An in-page fetch is same-origin, allowed by our
     * own connect-src, and returns the script SOURCE, which is what the
     * static detector reads. */
    // Navigate when we have no document yet, or when this URL lives on a
    // different origin than the one we are on. In-page fetch is only for
    // same-origin subresources, which is exactly what first-party scripts are.
    if (docOrigin === null || new URL(url).origin !== docOrigin) {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!resp) throw new Error("no response");
      const headers = resp.headers ? resp.headers() : {};
      const status = resp.status();
      const landed = (resp.url && resp.url()) || url;
      // the POST-REDIRECT origin, so the next call compares against reality
      try { docOrigin = new URL(landed).origin; } catch { docOrigin = null; }
      let body = null;
      return {
        ok: status >= 200 && status < 300,
        status,
        url: landed,
        headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
        text: async () => (body === null ? (body = await resp.text()) : body),
      };
    }

    const r = await page.evaluate(async (u, agent) => {
      try {
        // eslint-disable-next-line no-undef
        const res = await fetch(u, { headers: { accept: agent }, redirect: "follow" });
        const h = {};
        res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
        return { status: res.status, url: res.url, headers: h, body: await res.text() };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }, url, "text/html,application/javascript,*/*");

    if (!r || r.error) throw new Error((r && r.error) || "in-page fetch failed");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      url: r.url || url,
      headers: { get: (n) => r.headers[String(n).toLowerCase()] ?? null },
      text: async () => r.body,
    };
  };
}

/**
 * Fold a runtime result into a static verdict.
 *
 * THE COMBINATIONS THAT MATTER:
 *   declared + registers    -> registered   (the only affirmative claim)
 *   declared + none         -> declared_only, which is the 67 — the finding
 *   declared + unavailable  -> declared, and we say we could not run it
 *   not_declared + anything -> unchanged; we do not run a browser to confirm
 *                              an absence we already read
 */
export function combine(staticResult, runtime) {
  if (!staticResult || staticResult.verdict !== VERDICT.DECLARED) return staticResult;
  if (!runtime || !runtime.ok) {
    const reason = (runtime && runtime.reason) || UNAVAILABLE.NO_BINDING;
    const busy = reason === UNAVAILABLE.BUSY;
    return { ...staticResult, runtime_checked: false,
             ...(busy ? { retry_after_seconds: BUSY_RETRY_SECONDS } : {}),
             runtime_note: `Registration code is present. We could not run the page: ` +
                           `${reason}. Whether a tool actually registers is unknown, not no.` +
                           (busy ? ` Try again in about ${BUSY_RETRY_SECONDS} seconds.` : "") };
  }
  if (runtime.tools.length)
    return { ...staticResult, verdict: "registered", runtime_checked: true,
             tools: runtime.tools, tool_count: runtime.tools.length,
             runtime_note: `Executed the page and recorded ${runtime.tools.length} registered ` +
                           `tool(s). Tools are listed, never called.` };
  return { ...staticResult, verdict: "declared_only", runtime_checked: true,
           tools: [], tool_count: 0,
           runtime_note: `The registration code is present and nothing registered when the ` +
                         `page ran. This is the gap the index measures: 67 of 647 hosts ` +
                         `carrying the code registered nothing.` };
}
