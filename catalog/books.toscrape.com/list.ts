import { z } from "zod";
import { defineEndpoint } from "../../src/endpoint.ts";
import { bookCard, pageUrl, parseCards, parseTotalPages } from "./_shared.ts";

export default defineEndpoint({
  description: "One page of the full book catalogue (20 per page) with price, rating and stock.",
  input: z.object({ page: z.number().int().min(1).default(1) }),
  output: z.object({
    page: z.number().int(),
    total_pages: z.number().int(),
    books: z.array(bookCard).min(1),
  }),
  example: { page: 1 },
  async run(ctx, { page }) {
    const url = pageUrl(page);
    const $ = await ctx.html(url);
    return { page, total_pages: parseTotalPages($), books: parseCards($, url) };
  },
});
