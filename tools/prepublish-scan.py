#!/usr/bin/env python3
"""
prepublish-scan.py — refuse to publish private material.

Run before any push. Exits non-zero if anything matches.

TWO THINGS THIS FILE MUST NOT DO, both learned by doing them:

1. IT MUST NOT CONTAIN THE SECRETS IT LOOKS FOR. The first version hard-coded
   the real database and account identifiers as needles — a scanner that
   publishes what it is protecting. Identifiers now come from the environment
   or from a local private checkout, and only the SHAPE ships.

2. IT MUST NOT EXEMPT ITSELF SILENTLY. It skips its own file, because a
   pattern list is not a leak, and it PRINTS that it did. An exemption written
   into a guard is the guard's blind spot; an exemption printed on every run
   is a decision anyone can see and challenge.
"""
import os, re, sys

SELF = os.path.basename(__file__)

def env_needles():
    """Real identifiers, from the environment. Never literals in this file."""
    out = []
    for var in ("CLOUDFLARE_ACCOUNT_ID", "CF_D1_ID", "CLOUDFLARE_API_TOKEN",
                "OPENROUTER_API_KEY"):
        v = os.environ.get(var, "").strip()
        if len(v) >= 12:
            out.append(re.escape(v))
    return out

def canary_needles(private_repo):
    """The planted rows, read from a local private checkout if present."""
    path = os.path.join(private_repo, "migrations-2026-08-27.sql")
    try:
        sql = open(path).read()
    except OSError:
        return None                      # cannot check — reported, not assumed clean
    hosts = set(re.findall(r"\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b", sql))
    toks = set(re.findall(r"'([a-z]{8,})'", sql))
    return [re.escape(x) for x in (hosts | toks)]

PRIVATE = os.environ.get("KG_PRIVATE_REPO", os.path.expanduser("~/kg-worker"))

CATEGORIES = {
    "live credentials and identifiers (from env)": (env_needles(), re.I),
    "canary hostnames and tokens": (canary_needles(PRIVATE), re.I),
    "credential shapes":  ([r"Bearer\s+[A-Za-z0-9_-]{20,}", r"\bkg_[a-f0-9]{20,}",
                            # hex only: the first version put "-" inside the class
                            # and matched every ---- comment rule in the tree
                            r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"], re.I),
    "personal email addresses": ([r"[a-z0-9._%+-]+@(?:gmail|thegoodmarketer)\.[a-z.]+"], re.I),
    "index predicates and gates": ([r"\bLISTED\b", r"\bINDEXED\b", r"\bSUBMITTED\b",
                                   r"SELF_BUILT_MCP", r"NOT_FLAGGED", r"DEMOTED"], 0),
    "index, ranking and routing code": ([r"FROM sites", r"DB\.prepare", r"DB\.batch",
                                         r"onReplica", r"hydrate\(", r"VECTORIZE",
                                         r"handlePages", r"siteReport"], 0),
    "per-host index columns": ([r"strong_count", r"verification_tier", r"mcp_strict",
                                r"canonical_host", r"apparent_actions", r"enrichment_model"], 0),
    "private worker paths": ([r"src/pages\.js", r"src/index\.js", r"src/predicates\.js",
                              r"src/browse\.js", r"kg-worker"], re.I),
    "internal cache hostnames": ([r"page\.knowngood\.sh", r"figures\.knowngood\.sh",
                                  r"kg\.internal"], re.I),
    "cache and figures internals": ([r"figures\.json", r"FIGURES_VERSION", r"CACHE_VERSION"], re.I),
    "infrastructure config": ([r"wrangler", r"account_id", r"d1_databases"], re.I),
}

def main():
    files, skipped = [], []
    for root, dirs, fs in os.walk("."):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
        for f in fs:
            p = os.path.join(root, f)
            (skipped if f == SELF else files).append(p)

    blob = "\n".join(f"### {p}\n" + open(p, encoding="utf-8", errors="replace").read()
                     for p in files)
    lines = blob.split("\n")
    def where(n):
        for i in range(n - 1, -1, -1):
            if lines[i].startswith("### "): return lines[i][4:]
        return "?"

    bad = 0
    for label, (pats, flags) in CATEGORIES.items():
        if pats is None:
            print(f"  [??] {label:<44} COULD NOT CHECK (no private checkout at {PRIVATE})")
            bad += 1
            continue
        hits = []
        for p in pats:
            for m in re.finditer(p, blob, flags):
                n = blob[:m.start()].count("\n") + 1
                hits.append(f"{where(n)}:{n}")
        if hits: bad += 1
        print(f"  [{'ok' if not hits else '!!'}] {label:<44} "
              f"{'clean' if not hits else 'FOUND at ' + ', '.join(hits[:3])}")

    print(f"\n  {len(files)} file(s) scanned; {len(skipped)} skipped: "
          f"{', '.join(os.path.basename(s) for s in skipped) or 'none'}")
    print("  (the scanner skips itself: its pattern list is not a leak, and this "
          "exemption is printed rather than hidden)")
    if bad:
        print("\n  DO NOT PUBLISH.")
        return 1
    print("\n  Clean.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
