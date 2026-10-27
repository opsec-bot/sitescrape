# sitescrape

Turn a website into a typed API by replaying the requests its own frontend makes. Self-hosted and free; bring your own proxy and captcha keys if a site needs them.

```
$ sitescrape call books.toscrape.com/search '{"query":"light in the attic"}'
{
  "query": "light in the attic",
  "results": [
    { "id": "a-light-in-the-attic_1000", "title": "A Light in the Attic", "price": 51.77, "currency": "GBP", "rating": 3, "in_stock": true, ... }
  ]
}
```

## How it works

1. **Record.** `sitescrape record <url>` opens a browser and saves every request as a HAR file while you do the task.
2. **Digest.** The recording is cut down to the requests that carry data: static files, trackers and preflights are dropped, cookie and token values are masked. A typical digest is a few KB.
3. **Write the endpoint.** An agent (the `skill/` folder works with Claude Code) reads the digest and writes `catalog/<site>/<name>.ts`: zod input and output schemas plus a `run` function.
4. **Call it.** `sitescrape call <site>/<name> '<json>'`. Input and output are validated, so a site redesign shows up as a `bad_output` error instead of silently wrong data.

## Install

Requires Node 22+.

```
git clone https://github.com/opsec-bot/sitescrape && cd sitescrape
npm install
npx playwright install chromium   # optional: falls back to installed Chrome or Edge
node bin/sitescrape.mjs list
```

## Commands

| Command | What it does |
|---|---|
| `record <url> [--task "..."] [--seconds N] [--headless]` | Record a browsing session to `recordings/<host>/<time>/` |
| `digest <dir or .har> [--host example.com]` | Rebuild `digest.md` for a recording |
| `list` | List catalog endpoints |
| `call <site>/<name> [json]` | Run an endpoint |
| `login <url> [--site name]` | Log in by hand in a browser; cookies saved encrypted for endpoints with `session: true` |
| `logout <site>` | Delete a saved login |
| `probe [site or id ...] [--json] [--heal]` | Run every endpoint's example and record if it still works |
| `heal <site>/<name>` | Re-record the site and let Claude Code patch a broken endpoint |
| `serve [--port 8787] [--host 127.0.0.1]` | REST server: `GET /` lists endpoints with JSON Schema, `POST /<site>/<name>` calls one |
| `mcp` | MCP server on stdio, one tool per endpoint |

## Use from an agent

Every endpoint becomes an MCP tool (`books.toscrape.com/search` is `books_toscrape_com__search`). For Claude Code:

```
claude mcp add sitescrape -- node /path/to/sitescrape/bin/sitescrape.mjs mcp
```

Read endpoints are marked read-only; action endpoints are marked destructive so the client asks before running them.

## REST

```
$ sitescrape serve
$ curl -X POST localhost:8787/books.toscrape.com/book -d '{"id":"a-light-in-the-attic_1000"}'
{"data":{"id":"a-light-in-the-attic_1000","title":"A Light in the Attic","category":"Poetry","price":51.77,"available":22, ...}}
```

Errors come back as `{"error":{"code","message"}}` with status 400 (bad input), 404 (unknown endpoint or missing item), 502 (site error or the site changed shape). Set `SITESCRAPE_TOKEN` to require `Authorization: Bearer <token>`; the server refuses to bind to a non-local address without it.

## Proxies, captchas and logins

Bring your own services. Settings go in `.env` (see `.env.example`); nothing is sent anywhere else.

- **Proxy:** `PROXY_URL=http://user:pass@gate.example.com:7000`. If your provider takes a session id in the username, write `{session}` there. Calls then rotate IPs, and logged-in sites keep the IP they logged in from.
- **Captcha:** `CAPTCHA_PROVIDER=anticaptcha|capmonster|2captcha` and `CAPTCHA_API_KEY`. Endpoints call `ctx.solveCaptcha({ type, websiteURL, websiteKey })` for reCAPTCHA v2/v3, hCaptcha, Turnstile, or `{ type: "image", body }`. You pay the provider per solve.
- **Logins:** set `SESSION_KEY`, then `sitescrape login https://site.com/`. A browser opens and you log in yourself, so 2FA and captchas work. sitescrape never sees your password. Cookies, user agent and proxy session are saved AES-256-GCM encrypted in `sessions/`, refreshed after each call. Use test accounts.

Not covered: fingerprint-based bot detection with no captcha to solve.

## Health checks and self-healing

`sitescrape probe` runs each endpoint's `example` input and checks the output still matches the schema. Results go to `.sitescrape/status.json` and show in `sitescrape list`. Action endpoints are never run automatically. Logged-in endpoints are skipped until you have a saved login.

When a site changes, `sitescrape heal <id>` (or `probe --heal`):

1. records the endpoint's `source` page again (headless),
2. runs Claude Code headless (`claude -p`, your own subscription) with the failure, the fresh digest and the rendered HTML, allowed to edit only that site's folder,
3. probes again in a fresh process. Passing: the edit stays for you to review with `git diff`. Still failing: every file is put back.

Nothing is committed for you. To check daily, schedule `sitescrape probe --heal` with cron or Windows Task Scheduler.

## Catalog

This repo ships one example site, `books.toscrape.com` (a sandbox built for scraping practice). Endpoints for real sites live in [sitescrape-catalog](https://github.com/opsec-bot/sitescrape-catalog): install sitescrape there and run it from that folder, or point `SITESCRAPE_CATALOG` at its `catalog/` directory. Fork it to change an endpoint, open a pull request to share one.

## Writing an endpoint

```ts
import { defineEndpoint, z } from "sitescrape";

export default defineEndpoint({
  description: "One page of the book catalogue.",
  input: z.object({ page: z.number().int().min(1).default(1) }),
  output: z.object({ titles: z.array(z.string()).min(1) }),
  example: { page: 1 },
  async run(ctx, { page }) {
    const $ = await ctx.html(`https://books.toscrape.com/catalogue/page-${page}.html`);
    return { titles: $("article.product_pod h3 a").map((_, a) => $(a).attr("title")).get() };
  },
});
```

`ctx.json()`, `ctx.text()` and `ctx.html()` retry network errors and 429/5xx responses.

## Responsible use

Check a site's terms before automating it. Logged-in and action endpoints should use test accounts. sitescrape does not include bot-detection bypasses.

## License

MIT
