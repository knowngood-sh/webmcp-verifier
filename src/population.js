/**
 * population.js — the denominator, which is the differentiator.
 *
 * Checkers already outnumber known WebMCP implementations, so "we check
 * WebMCP" is not a pitch. What nobody else can hand back with a result is the
 * population it sits in: how many hosts were asked, how many could not be,
 * how many declared, how many actually registered, and on what date.
 *
 * FIGURES COME FROM THE FIGURES MODULE WITH THEIR DATES. Not one literal —
 * lint_figures fails the build on a bare 3-digit number in a renderer, and
 * that rule is why the numbers on this page can be trusted at all.
 *
 * NOTHING HERE READS THE INDEX. The population is published already; the
 * per-host rows are not, and a checker that consulted them would leak whether
 * we hold a host. See the boundary note in webmcp.js.
 */
/** The date the WebMCP run was measured, from the figures' own provenance. */
function measuredDate(f) {
  // A CLASS B key, deliberately. Class A figures are computed from D1 and
  // carry no provenance entry, so webmcp_runtime_total returns null here —
  // which is what the first version did, silently, in production while the
  // test passed on a hand-built stub. These keys come from the run itself.
  const prov = (f && f._provenance) || {};
  for (const k of ["webmcp_population_total", "webmcp_could_not_ask_total",
                   "webmcp_tool_names_total"]) {
    const iso = prov[k] && prov[k].measured_at;
    if (iso) return String(iso).slice(0, 10);
  }
  return null;
}

/** Every figure the sentences below actually name. */
const REQUIRED = ["webmcp_population_total", "webmcp_could_not_ask_total",
                  "webmcp_tested_total", "webmcp_runtime_total",
                  "webmcp_source_only_total"];

export function populationOf(f) {
  if (!f) return null;
  /**
   * AN INCOMPLETE POPULATION IS NO POPULATION.
   *
   * Caught on the real edge: the deployed figures object predated two Class B
   * keys, and `situate()` rendered "— hosts we scanned on 2026-08-31", a
   * sentence with a hole where the denominator goes. That is worse than
   * omitting the block — it is a published measurement missing its number.
   *
   * It is also the could-not-ask rule applied to ourselves: if we cannot state
   * the population, we do not state a partial one. The caller omits the
   * section, exactly as it does when figures are unavailable entirely.
   *
   * In practice a missing key means a cached figures object outlived a change
   * to its own shape: whatever keys that cache was not revised when a key was
   * added. Refusing here turns that into a missing section rather than a
   * published sentence with a hole where the denominator goes.
   */
  for (const k of REQUIRED) if (f[k] == null) return null;
  return {
    // the chain, in the order it happened
    crawled: f.webmcp_population_total,
    could_not_be_asked: f.webmcp_could_not_ask_total,
    carried_the_code: f.webmcp_tested_total,
    registered_at_runtime: f.webmcp_runtime_total,
    code_but_registered_nothing: f.webmcp_source_only_total,
    distinct_tool_names: f.webmcp_tool_names_total,
    registration_rate_pct: f.webmcp_runtime_share,
    // the measurement DATE is provenance, not prose: taken from the run that
    // produced these figures, so it cannot drift from them. Typing it here
    // was caught by the test that forbids a literal in this file.
    measured: measuredDate(f),
    data_as_of: f.data_as_of,
  };
}

/**
 * One sentence placing a verdict in that population. Written per verdict
 * rather than as one template, because "could not ask" is the state the
 * population makes meaningful — 1,224 of 13,989 could not be asked either,
 * and saying so turns an apology into a measurement.
 */
export function situate(verdict, p) {
  if (!p) return null;
  const n = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
  switch (verdict) {
    case "declared":
      return `${n(p.carried_the_code)} of ${n(p.crawled)} hosts we scanned on ` +
             `${p.measured} carried the registration code. Of those, ` +
             `${n(p.registered_at_runtime)} actually registered a tool when the page ran ` +
             `and ${n(p.code_but_registered_nothing)} registered nothing.`;
    case "not_declared":
      return `${n(p.crawled)} hosts scanned on ${p.measured}; ` +
             `${n(p.carried_the_code)} carried the code. Not declaring is the ` +
             `overwhelming majority position, not a deficiency.`;
    case "could_not_ask":
      return `${n(p.could_not_be_asked)} of ${n(p.crawled)} hosts in our own scan on ` +
             `${p.measured} could not be asked either. We report that as its own ` +
             `state rather than as a no.`;
    case "excluded":
      return `Excluded at the host's request. Our scan of ${n(p.crawled)} hosts on ` +
             `${p.measured} honours the same signal.`;
    default: return null;
  }
}
