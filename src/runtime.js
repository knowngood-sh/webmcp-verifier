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
  if (!runtime || !runtime.ok)
    return { ...staticResult, runtime_checked: false,
             runtime_note: `Registration code is present. We could not run the page: ` +
                           `${(runtime && runtime.reason) || UNAVAILABLE.NO_BINDING}. ` +
                           `Whether a tool actually registers is unknown, not no.` };
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
