---
name: sitescrape
description: Turn a website into typed sitescrape endpoints. Use when the user wants an API, scraper or MCP tool for a site, or asks to record, compile, fix or heal a sitescrape endpoint.
---

# sitescrape

You write endpoints for the sitescrape catalog. The user's machine does the fetching; you only read a small digest and write TypeScript.

## Steps

1. **Check the catalog.** Run `sitescrape list`. If the site already has the endpoint, call it instead of building a new one.
2. **Record.** `sitescrape record <url> --task "<what the user wants>"`. The user does the task in the browser and presses Enter. Headless runs with `--seconds N` only work for pages that load their data on their own.
3. **Read the digest only.** Open `recordings/<host>/<stamp>/digest.md`. Do not open `network.har` unless the digest is missing a request body you need, and then search it for that one URL. Never print or copy `state.json`: it holds live cookies.
4. **Pick the source.**
   - A JSON request carries the data: replay it with `ctx.json()`. Keep only the headers the digest shows are needed. Drop tracking params.
   - The data is only in the HTML document: use `ctx.html()` and cheerio selectors.
   - Prefer JSON. It is faster and breaks less.
5. **Write `catalog/<host>/<name>.ts`.** One endpoint per file, default export of `defineEndpoint`:
   - `input` and `output` are zod schemas. Snake_case output keys. Numbers as numbers, not strings.
   - `example` must be a real input that returns data today. Probes use it.
   - Shared parsing goes in `catalog/<host>/_shared.ts`.
   - Set `kind: "action"` for anything that changes state on the site (posts, bookings, purchases).
   - Validate ids in `input` with a regex so user input never builds arbitrary URLs.
6. **Verify.** `sitescrape call <host>/<name> '<example json>'`. Output must pass the schema. Then save the fetched page or JSON to `test/fixtures/` and add a test that runs the endpoint on the fixture.

## Rules

- Secrets (cookies, tokens, API keys) never go in catalog files, fixtures or digests. Endpoints get auth from the context.
- Action endpoints and logged-in endpoints: test accounts only. Ask the user before running any action against a live site.
- If the site sits behind a captcha or bot wall the recording cannot get past, say so. Do not try to defeat it in endpoint code.
