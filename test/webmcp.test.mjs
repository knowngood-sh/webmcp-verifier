/**
 * The WebMCP checker. Layer 1 (static) is what ships regardless; layer 2
 * (runtime enumeration) is gated on Browser Rendering being available and
 * degrades to could_not_ask when it is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as W from "../src/webmcp.js";
import * as P from "../src/population.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (b) => b.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A path-exact fetch stub. Matching on substring silently served the HTML
 *  for a script request and made a "declared in a bundle" case look absent. */
const stub = (map) => async (u) => {
  const p = new URL(u).pathname;
  if (!(p in map)) return new Response("nf", { status: 404 });
  const v = map[p];
  if (typeof v === "number") return new Response("", { status: v });
  if (v && v.status) return new Response(v.body || "", { status: v.status, headers: v.headers || {} });
  return new Response(v, { status: 200, headers: { "content-type":
    p.endsWith(".js") ? "application/javascript" : p === "/robots.txt" ? "text/plain" : "text/html" } });
};
const check = (map, host = "x.example") => W.checkWebmcp(host, { fetchImpl: stub(map) });

/* ------------------------------------------------------------- consent -- */

test("ai-input=no is an absolute stop, reported as excluded and never as failing", async () => {
  const r = await check({ "/robots.txt": "User-agent: *\nContent-Signal: ai-input=no",
                          "/": "<html>navigator.modelContext.provideContext({})</html>" });
  assert.equal(r.verdict, W.VERDICT.EXCLUDED);
  assert.match(r.reason, /ai-input=no/);
  // the page carried a declaration and we still did not report one — the
  // refusal is not a result about WebMCP at all
  assert.equal(r.evidence, undefined);
  assert.equal(/fail|not_declared|no\b/i.test(r.verdict), false);
  // and it is not silently omitted: the host appears, with its reason
  assert.equal(r.host, "x.example");
});

test("a named group beats the wildcard, in either direction", () => {
  const named = "User-agent: KnownGood-Verifier\nContent-Signal: ai-input=no\n\n" +
                "User-agent: *\nContent-Signal: ai-input=yes";
  assert.equal(W.aiInputStance(named), "no");
  assert.equal(W.aiInputStance("User-agent: *\nContent-Signal: ai-input=yes"), "yes");
  // absent is absent — neither consent nor refusal
  assert.equal(W.aiInputStance("User-agent: *\nAllow: /"), "unset");
  assert.equal(W.aiInputStance(""), "unset");
});

test("robots.txt is read before the page is requested", async () => {
  const order = [];
  await W.checkWebmcp("x.example", { fetchImpl: async (u) => {
    order.push(new URL(u).pathname);
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  } });
  assert.equal(order[0], "/robots.txt", `first request was ${order[0]}`);
});

test("the user agent is ours and is never disguised", async () => {
  let seen = null;
  await W.checkWebmcp("x.example", { fetchImpl: async (u, o) => {
    seen = seen || (o && o.headers && o.headers["user-agent"]);
    return new Response("", { status: 404 });
  } });
  assert.match(seen, /^KnownGood-Verifier/);
  assert.match(seen, /knowngood\.sh\/bot/);
  assert.equal(/mozilla|chrome|safari|bot\)$/i.test(seen), false, "must not impersonate a browser");
});

test("Retry-After is honoured by refusing, not by sleeping", async () => {
  const r = await check({ "/robots.txt": "",
    "/": { status: 429, headers: { "retry-after": "120" } } });
  assert.equal(r.verdict, W.VERDICT.COULD_NOT_ASK);
  assert.equal(r.retry_after, "120");
  assert.match(r.reason, /rate-limited/);
});

/* ------------------------------------------------------------ detection - */

test("a declaration is a call shape, so prose about WebMCP does not match", () => {
  assert.deepEqual(W.detectStatic("This article explains provideContext and registerTool."), []);
  assert.deepEqual(W.detectStatic("What is navigator modelContext? A guide."), []);
  assert.ok(W.detectStatic("navigator.modelContext.provideContext({tools:[]})").length);
});

test("both entry points match, because the spec renamed one mid-trial", () => {
  const a = W.detectStatic("navigator.modelContext").map((e) => e.pattern);
  const b = W.detectStatic("document.modelContext").map((e) => e.pattern);
  assert.deepEqual(a, ["navigator.modelContext"]);
  assert.deepEqual(b, ["document.modelContext"]);
});

test("evidence carries the matched context, so a false positive is visible", async () => {
  const r = await check({ "/robots.txt": "",
    "/": "<html><script>window.x=1; navigator.modelContext.provideContext({tools:[]});</script></html>" });
  assert.equal(r.verdict, W.VERDICT.DECLARED);
  assert.ok(r.evidence.length >= 1);
  for (const e of r.evidence) {
    assert.ok(e.pattern && e.where && e.context, "each match needs pattern, location and context");
    assert.ok(e.context.length <= 120);
  }
});

test("only first-party scripts are fetched", async () => {
  const asked = [];
  await W.checkWebmcp("x.example", { fetchImpl: async (u) => {
    asked.push(u);
    const p = new URL(u).pathname;
    if (p === "/") return new Response(
      '<html><script src="https://cdn.other.com/b.js"></script><script src="/a.js"></script></html>',
      { status: 200, headers: { "content-type": "text/html" } });
    return new Response("", { status: 200, headers: { "content-type": "application/javascript" } });
  } });
  assert.equal(asked.some((u) => u.includes("cdn.other.com")), false,
    "a third-party script must never be fetched by the checker");
  assert.ok(asked.some((u) => u.endsWith("/a.js")));
});

/* ------------- the state that is the product: could not ask -------------- */

test("a script we could not read makes it could_not_ask, never not_declared", async () => {
  const r = await check({ "/robots.txt": "", "/": '<html><script src="/a.js"></script></html>' });
  assert.equal(r.verdict, W.VERDICT.COULD_NOT_ASK);
  assert.match(r.reason, /could not be read/);
});

test("a script robots disallows also makes it could_not_ask", async () => {
  const r = await check({ "/robots.txt": "User-agent: *\nDisallow: /a.js",
                          "/": '<html><script src="/a.js"></script></html>', "/a.js": "x" });
  assert.equal(r.verdict, W.VERDICT.COULD_NOT_ASK);
  assert.equal(r.scripts_skipped_by_robots, 1);
  assert.match(r.reason, /disallowed by robots/);
});

test("not_declared is only reached when everything intended was read", async () => {
  const r = await check({ "/robots.txt": "", "/": "<html><p>nothing here</p></html>" });
  assert.equal(r.verdict, W.VERDICT.NOT_DECLARED);
  assert.equal(r.scripts_skipped_by_robots, 0);
  assert.deepEqual(r.evidence, []);
});

test("every failure mode is could_not_ask and none is a negative", async () => {
  for (const [name, map] of [
    ["404", { "/robots.txt": "" }],
    ["500", { "/robots.txt": "", "/": 500 }],
    ["not html", { "/robots.txt": "", "/": { status: 200, body: "{}", headers: { "content-type": "application/json" } } }],
  ]) {
    const r = await check(map);
    assert.equal(r.verdict, W.VERDICT.COULD_NOT_ASK, `${name} became ${r.verdict}`);
    assert.ok(r.reason, `${name} must say why`);
  }
  const bad = await W.checkWebmcp("not a url at all", { fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal(bad.verdict, W.VERDICT.COULD_NOT_ASK);
});

/* ------------------------------------------------------------ boundary -- */

/**
 * THE BOUNDARY. The checker may read the live host and the published
 * population figures, and nothing else. A checker that consulted our per-host
 * rows would leak whether the index holds a host — including by answering
 * differently for hosts it holds — which breaks the byte-identical rule
 * get_site_report is built on.
 *
 * Asserted structurally, because "we didn't do that" is not a mechanism.
 */
/** The detector core: standalone, and the only part that goes in the public
 *  repo. It may import nothing but itself. */
const CORE = ["webmcp.js", "runtime.js", "population.js"];

test("the detector core is standalone — it imports nothing from the worker", () => {
  for (const f of CORE) {
    const code = strip(read("../src/" + f));
    for (const m of code.matchAll(/from\s+["']([^"']+)["']/g))
      assert.match(m[1], /^\.\/(webmcp|runtime|population)\.js$|^node:/,
        `src/verify/${f} imports ${m[1]}; the core must be portable to the public repo`);
  }
});

/**
 * THE BOUNDARY, which is about the INDEX and not about imports.
 *
 * The surfaces (page.js, route.js) legitimately use shell() for chrome and
 * getFigures() for the published population — point 3 allows exactly those
 * two inputs. What no file here may do is reach a per-host index row: a
 * checker that answered differently for hosts we hold would leak whether the
 * index holds them, which breaks the byte-identical rule get_site_report is
 * built on.
 */
/**
 * The library's own boundary: it takes a URL and a fetch, and nothing else.
 * (The stricter test that names the host application's internals lives in that
 * application, where it guards something. Restating those names here would
 * publish them for no benefit.)
 */
test("a verdict carries only what the live check produced", async () => {
  const r = await check({ "/robots.txt": "", "/": "<html></html>" });
  const allowed = new Set(["verdict", "host", "url", "checked_at", "user_agent",
    "reason", "note", "evidence", "robots_read", "scripts_found", "scripts_fetched",
    "scripts_skipped_by_robots", "retry_after", "input"]);
  for (const k of Object.keys(r))
    assert.ok(allowed.has(k), `the verdict exposes an unexpected field: ${k}`);
});




/* ---------------------------------------------------------- population -- */

test("the population is figures-derived and dated, with no literals", () => {
  const f = { webmcp_population_total: 13989, webmcp_could_not_ask_total: 1224,
              webmcp_tested_total: 647, webmcp_runtime_total: 580,
              webmcp_source_only_total: 67, webmcp_tool_names_total: 997,
              webmcp_runtime_share: 89.6, data_as_of: "2026-08-28",
              _provenance: { webmcp_population_total: { measured_at: "2026-08-31T00:00:00Z" } } };
  const p = P.populationOf(f);
  assert.equal(p.crawled, 13989);
  assert.equal(p.could_not_be_asked, 1224);
  assert.equal(p.data_as_of, "2026-08-28");
  for (const v of ["declared", "not_declared", "could_not_ask", "excluded"]) {
    const s = P.situate(v, p);
    assert.ok(s && s.length > 40, `${v} has no population sentence`);
    assert.match(s, /2026-08-31|13,989|1,224/, `${v} states no dated population`);
  }
  assert.equal(P.populationOf(null), null, "no figures must degrade, never invent");
  // the date must come from a CLASS B key: Class A figures carry no
  // provenance, and reaching for one returned null in production while this
  // test passed on a stub that supplied it
  const noProv = P.populationOf({ ...f, _provenance: { webmcp_runtime_total: { measured_at: "2026-08-31T00:00:00Z" } } });
  assert.equal(noProv.measured, null,
    "measuredDate must read a Class B key, not a computed one");
  // the source file carries no figure literal
  const src = read("../src/population.js").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/\b\d{3,}\b/.test(src), false, "population.js carries a figure literal");
});

/* ---------------------------------------------------------------- layer 2
 * Layer 2 runs the page in a headless browser. It exists to turn "the code
 * is there" into "a tool actually registered". It must never do the reverse:
 * a browser that works is not a licence to state a negative the static layer
 * never established. Every assertion below fails if its gate is removed. */

const fakePage = (tools) => ({
  evaluated: [], ua: null, closed: false, gotos: [], invoked: [],
  async setUserAgent(ua) { this.ua = ua; },
  async evaluateOnNewDocument(src) { this.evaluated.push(String(src)); },
  async goto(u) { this.gotos.push(u); },
  async evaluate() { return tools; },
  async close() { this.closed = true; },
});

test("the probe script records tools and never invokes one", async () => {
  const R = await import("../src/runtime.js");
  const shim = R.PROBE_SCRIPT;
  assert.match(shim, /registerTool\(t\)\s*\{\s*record\(t\)/, "registerTool must record, not call");
  assert.equal(/t\.(call|invoke|execute|run)\s*\(/.test(shim), false,
    "the probe script calls a tool it was handed");
  assert.equal(/\bfn\s*\(|handler\s*\(/.test(shim), false, "the probe script invokes a handler");
  // both entry points, because the spec renamed one mid-trial
  assert.match(shim, /navigator/); assert.match(shim, /document/);
});

test("the browser carries our user agent, and the page is always closed", async () => {
  const R = await import("../src/runtime.js");
  const page = fakePage(["a_tool"]);
  const r = await R.enumerateTools("https://x.example/", { openPage: async () => page });
  assert.deepEqual(r.tools, ["a_tool"]);
  assert.match(page.ua, /^KnownGood-Verifier/, "the browser must not be disguised");
  assert.equal(page.closed, true, "an unclosed page leaks a browser slot");
});

test("the runtime layer never downgrades a static verdict", async () => {
  const { combine } = await import("../src/runtime.js");
  for (const v of [W.VERDICT.NOT_DECLARED, W.VERDICT.COULD_NOT_ASK, W.VERDICT.EXCLUDED]) {
    const before = { verdict: v, host: "x" };
    assert.deepEqual(combine(before, { ok: true, tools: [] }), before,
      `${v} was rewritten by a runtime result`);
  }
  const d = combine({ verdict: W.VERDICT.DECLARED, host: "x" }, { ok: false, reason: "busy" });
  assert.equal(d.verdict, W.VERDICT.DECLARED, "a browser failure must not produce a negative");
  assert.equal(d.runtime_checked, false);
  assert.match(d.runtime_note, /unknown, not no/);
});

test("every browser failure is stated as unknown, never as a negative", async () => {
  const { combine, UNAVAILABLE } = await import("../src/runtime.js");
  for (const reason of Object.values(UNAVAILABLE)) {
    const r = combine({ verdict: W.VERDICT.DECLARED, host: "x" }, { ok: false, reason });
    assert.equal(r.verdict, W.VERDICT.DECLARED, `${reason} produced ${r.verdict}`);
    assert.equal(r.runtime_checked, false, `${reason} claimed the runtime was checked`);
  }
});

test("a refusal under load states how long to wait, and is never a 500", async () => {
  const { BUSY_RETRY_SECONDS, combine, UNAVAILABLE } = await import("../src/runtime.js");
  assert.ok(Number.isInteger(BUSY_RETRY_SECONDS) && BUSY_RETRY_SECONDS > 0,
    "a busy refusal with no stated wait is an error, not a refusal");
  const r = combine({ verdict: W.VERDICT.DECLARED, host: "x" },
    { ok: false, reason: UNAVAILABLE.BUSY, retry_after_seconds: BUSY_RETRY_SECONDS });
  assert.equal(r.retry_after_seconds, BUSY_RETRY_SECONDS);
  assert.equal(r.verdict, W.VERDICT.DECLARED);
});

test("an incomplete population is no population", () => {
  const full = {
    webmcp_population_total: 10, webmcp_could_not_ask_total: 2,
    webmcp_tested_total: 3, webmcp_runtime_total: 2, webmcp_source_only_total: 1,
    _provenance: { webmcp_population_total: { measured_at: "2026-08-31T00:00:00Z" } },
  };
  assert.ok(P.populationOf(full), "a complete figures object must yield a population");
  assert.equal(P.populationOf(null), null);
  // a cached figures object predating a key must refuse, not render a blank
  for (const k of Object.keys(full).filter((k) => k !== "_provenance")) {
    const partial = { ...full, [k]: null };
    assert.equal(P.populationOf(partial), null,
      `a population was rendered with ${k} missing — it would print an empty denominator`);
  }
});

/* ------------------------------------- a mention is not a call, in the file --
 *
 * The rule was enforced against prose in the page and not against prose in
 * the file, so comments and string literals still matched. Measured on the
 * author's own /webmcp.js: provideContext 2 occurrences and 0 in code,
 * unregisterTool 1 and 0, registerTool 6 and 2 — two tokens shown to readers
 * as evidence that no code ever used. */

const ALL_MENTIONS = `<!doctype html>
<!-- This page explains navigator.modelContext and document.modelContext. -->
<h1>How to use provideContext()</h1>
<p>Call registerTool() to add a tool, and unregisterTool() to remove one.</p>
<script>
  // navigator.modelContext.provideContext({ tools: [] });
  /* registerTool(t) and unregisterTool(t) are the two halves of the API. */
  const docs = "call navigator.modelContext.provideContext() to register";
</script>`;

test("a file that mentions every token and calls none is not_declared", async () => {
  const r = await W.checkWebmcp("mentions.example", {
    fetchImpl: stub({ "/robots.txt": "", "/": ALL_MENTIONS }),
  });
  assert.equal(r.verdict, W.VERDICT.NOT_DECLARED,
    `prose about WebMCP was read as WebMCP: ${JSON.stringify(r.evidence)}`);
  assert.deepEqual(r.evidence || [], []);
});

test("each token in a comment or a string is invisible; in code it is not", () => {
  for (const call of ["navigator.modelContext", "document.modelContext",
                      "provideContext(", "registerTool(", "unregisterTool("]) {
    for (const hidden of [`// ${call}`, `/* ${call} */`, `<!-- ${call} -->`,
                          `var s = "${call}";`, `var s = '${call}';`])
      assert.deepEqual(W.detectStatic(hidden), [], `${call} matched while hidden in: ${hidden}`);
    assert.ok(W.detectStatic(`x = ${call})`).length >= 1, `${call} stopped matching in real code`);
  }
});

test("in HTML, only script contents are code", () => {
  assert.deepEqual(W.detectStatic(ALL_MENTIONS, "p", { html: true }), [],
    "page prose was read as an implementation");
  const real = '<html><p>docs about registerTool()</p>' +
               '<script>navigator.modelContext.provideContext({tools:[]})</script></html>';
  assert.ok(W.detectStatic(real, "p", { html: true }).length >= 1,
    "a real inline registration stopped matching");
});

test("an evidence excerpt never opens or closes mid-token", () => {
  const src = 'if (typeof navigator !== "undefined") collect(navigator.modelContext); ' +
              'if (typeof document !== "undefined") collect(document.modelContext);';
  const flat = src.replace(/\s+/g, " ");
  const ev = W.detectStatic(src, "webmcp.js");
  assert.ok(ev.length >= 2);
  for (const e of ev) {
    const body = e.context.replace(/^…/, "").replace(/…$/, "");
    const i = flat.indexOf(body);
    assert.ok(i >= 0, `excerpt is not a slice of the source: ${JSON.stringify(body)}`);
    if (i > 0 && /[\w$]/.test(body[0]))
      assert.equal(/[\w$]/.test(flat[i - 1]), false, `excerpt opens mid-token: ${e.context}`);
    const j = i + body.length;
    if (j < flat.length && /[\w$]/.test(body[body.length - 1]))
      assert.equal(/[\w$]/.test(flat[j]), false, `excerpt closes mid-token: ${e.context}`);
    assert.equal(/^…?(peof|ypeof)\b/.test(e.context), false, `a beheaded token survived: ${e.context}`);
  }
});

test("the population block states the number and stops", () => {
  const POP = { crawled: 13989, could_not_be_asked: 1224, carried_the_code: 647,
                registered_at_runtime: 580, code_but_registered_nothing: 67,
                distinct_tool_names: 997, measured: "2026-08-31" };
  assert.equal(P.situate("not_declared", POP),
    "13,989 hosts scanned on 2026-08-31; 647 carried the code.");
  /* Stating the number is the product; telling a reader how to feel about
     their own result is not, and "not a deficiency" cannot hold uniformly —
     for a site with a checkout it may well be one. Deleted, not softened. */
  for (const v of ["declared", "not_declared", "could_not_ask", "excluded"])
    for (const banned of ["not a deficiency", "overwhelming majority"])
      assert.equal((P.situate(v, POP) || "").toLowerCase().includes(banned), false,
        `the ${v} block carries "${banned}"`);
});
