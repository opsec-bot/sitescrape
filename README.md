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

> Early work in progress. Recording, digesting and calling work. REST server, MCP server, proxy and captcha support, logins and self-healing are next.

## How it works

1. **Record.** `sitescrape record <url>` opens a browser and saves every request as a HAR file while you do the task.
2. **Digest.** The recording is cut down to the requests that carry data: static files, trackers and preflights are dropped, cookie and token values are masked. A typical digest is a few KB.
3. **Write the endpoint.** An agent (the `skill/` folder works with Claude Code) reads the digest and writes `catalog/<site>/<name>.ts`: zod input and output schemas plus a `run` function.
4. **Call it.** `sitescrape call <site>/<name> '<json>'`. Input and output are validated, so a site redesign shows up as a `bad_output` error instead of silently wrong data.

## Install

Requires Node 22+.

```
git clone <repo> && cd sitescrape
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

## Writing an endpoint

```ts
import { z } from "zod";
import { defineEndpoint } from "../../src/endpoint.ts";

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
