import re, os, sys
NEEDLES = {
 "canary hostnames / tokens": None,
 "D1 database id":            [r"c1bb7a28-9196-4850-8f6d-4a6e0ec1c8f8", r"database_id"],
 "Cloudflare account id":     [r"778ad9c74a52a23b0b2a739cbe265bf3", r"CLOUDFLARE_ACCOUNT_ID"],
 "API tokens / bearer creds": [r"CLOUDFLARE_API_TOKEN", r"OPENROUTER_API_KEY", r"Bearer\s+[A-Za-z0-9_-]{20,}", r"\bkg_[a-f0-9]{20,}"],
 "notify / personal email":   [r"deanhomex@gmail\.com", r"tom@thegoodmarketer\.co\.uk"],
 # CASE-SENSITIVE: the first version matched the English word "listed" in prose
 # and reported a leak. A scan that cries wolf is a scan people stop reading.
 "index predicates & gates":  [r"\bLISTED\b", r"\bINDEXED\b", r"\bSUBMITTED\b", r"SELF_BUILT_MCP", r"NOT_FLAGGED", r"DEMOTED"],
 "index/ranking/routing code":[r"FROM sites", r"DB\.prepare", r"DB\.batch", r"onReplica", r"hydrate\(", r"VECTORIZE", r"handlePages", r"siteReport"],
 "per-host index columns":    [r"strong_count", r"verification_tier", r"mcp_strict", r"canonical_host", r"apparent_actions", r"enrichment_model"],
 "private worker paths":      [r"src/pages\.js", r"src/index\.js", r"src/predicates\.js", r"src/browse\.js", r"kg-worker"],
 "internal cache hostnames":  [r"page\.knowngood\.sh", r"figures\.knowngood\.sh", r"kg\.internal"],
 "cache/figures internals":   [r"figures\.json", r"FIGURES_VERSION", r"CACHE_VERSION"],
 "wrangler / infra config":   [r"wrangler", r"account_id", r"\[\[d1_databases\]\]"],
}
CASE_SENSITIVE = {"index predicates & gates", "index/ranking/routing code", "per-host index columns"}
try:
    sql = open('/home/ubuntu/kg-worker/migrations-2026-08-27.sql').read()
    hosts = set(re.findall(r'\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b', sql))
    toks  = set(re.findall(r'\b(zubrowette|quenthaptic|marloviant|drosselfane|vintrelock)\b', sql))
    NEEDLES["canary hostnames / tokens"] = [re.escape(x) for x in (hosts | toks)]
except FileNotFoundError:
    NEEDLES["canary hostnames / tokens"] = []
files=[]
for root,dirs,fs in os.walk('.'):
    dirs[:]=[d for d in dirs if d!='.git']
    for f in fs: files.append(os.path.join(root,f))
blob="\n".join(f"### {f}\n"+open(f,encoding='utf-8',errors='replace').read() for f in files)
lines=blob.split("\n")
def which(n):
    for i in range(n-1,-1,-1):
        if lines[i].startswith("### "): return lines[i][4:]
    return "?"
bad=0
for label,pats in NEEDLES.items():
    flags = 0 if label in CASE_SENSITIVE else re.I
    hits=[]
    for p in (pats or []):
        for m in re.finditer(p, blob, flags):
            n = blob[:m.start()].count("\n")+1
            hits.append(f"{which(n)}:{n} {m.group(0)[:24]!r}")
    if hits: bad+=1
    print(f"  [{'ok' if not hits else '!!'}] {label:<28} {'CLEAN' if not hits else 'FOUND: '+'; '.join(hits[:3])}")
print(f"\n  files {len(files)} · categories {len(NEEDLES)} · with hits {bad}")
sys.exit(1 if bad else 0)
