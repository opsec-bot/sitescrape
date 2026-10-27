import { z } from "zod";
import { defineEndpoint } from "../../src/endpoint.ts";
import { bookCard, pageUrl, parseCards, parseTotalPages, type BookCard } from "./_shared.ts";

// The site has no search box, so this scans the catalogue pages a few at a time and filters by title.
const CONCURRENCY = 5;

export default defineEndpoint({
  description: "Find books whose title contains the query (case-insensitive).",
  input: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(10),
  }),
  output: z.object({ query: z.string(), results: z.array(bookCard) }),
  example: { query: "light in the attic" },
  async run(ctx, { query, limit }) {
    const needle = query.toLowerCase();
    const first = await ctx.html(pageUrl(1));
    const total = parseTotalPages(first);
    const results: BookCard[] = match(parseCards(first, pageUrl(1)), needle);

    for (let start = 2; start <= total && results.length < limit; start += CONCURRENCY) {
      const pages = range(start, Math.min(start + CONCURRENCY - 1, total));
      const batches = await Promise.all(pages.map(async (p) => parseCards(await ctx.html(pageUrl(p)), pageUrl(p))));
      for (const cards of batches) results.push(...match(cards, needle));
    }
    return { query, results: results.slice(0, limit) };
  },
});

function match(cards: BookCard[], needle: string): BookCard[] {
  return cards.filter((c) => c.title.toLowerCase().includes(needle));
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
