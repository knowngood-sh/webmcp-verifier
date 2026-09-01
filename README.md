# webmcp-verifier

Check whether a website declares [WebMCP](https://github.com/webmachinelearning/webmcp)
tools — and, where a browser is available, whether any tool **actually registers
when the page runs**.

Apache-2.0. Extracted from the checker running at
[knowngood.sh/verify/webmcp](https://knowngood.sh/verify/webmcp).

## Why another checker

There are already more WebMCP checkers than known WebMCP implementations. This
one differs in two ways, and both are about honesty rather than features.

**1. "Could not ask" is a first-class answer.**

Most checkers have two states: yes and no. A timeout, a rate limit, a script
they could not read, a page that would not load — all collapse into *no*, and
the collapse is always in the same direction: toward a confident negative.

This one has four:

| verdict | meaning |
|---|---|
| `registered` | a tool registered when we executed the page |
| `declared_only` | the code is there and **nothing registered** |
| `declared` | the registration code is present; we could not run the page |
| `not_declared` | we read the page and every first-party script, and it is not there |
| `could_not_ask` | we could not complete the check — **this is not a no** |
| `excluded` | the site's `robots.txt` refuses AI input, so we did not check |

`not_declared` is only reached when everything we intended to read came back.
One unreadable script, or one a site's `robots.txt` disallows, makes the answer
`could_not_ask` — because the declaration could have been in it.

**2. Declared is not registered.**

A static scan proves a registration *exists*. It does not prove anything
registers: a script that throws, is gated behind consent, or never runs
registers nothing. In a full-index pass of 13,989 hosts on 2026-08-31, 647
carried the code and 580 registered — **67 declared and delivered nothing**.
A checker that reports the first as the second is wrong about roughly one site
in ten that it finds.

## Consent

Non-negotiable, and the reason this is safe to point at any host:

- **`robots.txt` is read before the resource request**, every time.
- **`ai-input=no` is an absolute stop.** The host is reported as `excluded`,
  never as failing a check that was not run — and never silently omitted,
  because omission lets a caller infer refusal from absence.
- **The user agent is `KnownGood-Verifier` and is never disguised.**
- **`Retry-After` is honoured by refusing**, not by sleeping inside a request
  and holding a connection open on someone else's rate limit.
- **Tools are listed, never invoked.** Calling a stranger's tool could place an
  order, send a message, or change state on a site that never agreed to it.
- Only **first-party** scripts are fetched.

## Use

```js
import { checkWebmcp } from "webmcp-verifier";

const result = await checkWebmcp("example.com");
// { verdict, host, checked_at, evidence: [{ pattern, where, context }], ... }
```

Runtime enumeration needs a browser. `openPage` is injected, so this library
has no hard dependency on any one provider — pass a function returning a
Puppeteer-compatible page:

```js
import { enumerateTools, combine } from "webmcp-verifier/runtime";

const runtime = await enumerateTools(url, { openPage });
const full = combine(result, runtime);   // may become `registered` or `declared_only`
```

With no `openPage`, `combine` returns the static verdict and says the page was
not run. It never invents a negative.

## What counts as a declaration

Both entry points, because the July 2026 draft renamed
`navigator.modelContext` to `document.modelContext` mid-origin-trial and the
API surface is still moving:

`navigator.modelContext` · `document.modelContext` · `provideContext(` ·
`registerTool(` · `unregisterTool(`

Each pattern requires a **call or member access**, never a bare word — so an
article *about* WebMCP does not match. Every result carries the matched text so
a false positive is visible rather than trusted.

## What this repository is not

The verifier only. It contains no index, no ranking, no routing, and no data
about any host. The population figures a result is placed in are published
separately and passed in.

## Tests

```
npm test
```
