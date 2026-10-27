import { defineEndpoint, z } from "sitescrape";
import { BASE, parseMoney, parseRating } from "./_shared.ts";

export default defineEndpoint({
  description: "Full details for one book by id (the slug from list or search).",
  input: z.object({ id: z.string().regex(/^[a-z0-9-]+_\d+$/, "expected a slug like a-light-in-the-attic_1000") }),
  output: z.object({
    id: z.string(),
    title: z.string().min(1),
    upc: z.string(),
    category: z.string(),
    price: z.number(),
    price_excl_tax: z.number(),
    tax: z.number(),
    currency: z.string(),
    rating: z.number().int().min(0).max(5),
    in_stock: z.boolean(),
    available: z.number().int(),
    reviews: z.number().int(),
    description: z.string(),
    image: z.string(),
    url: z.string(),
  }),
  example: { id: "a-light-in-the-attic_1000" },
  async run(ctx, { id }) {
    const url = `${BASE}${id}/index.html`;
    const $ = await ctx.html(url);
    const table = Object.fromEntries(
      $("table.table-striped tr")
        .toArray()
        .map((tr) => [$(tr).find("th").text().trim(), $(tr).find("td").text().trim()]),
    );
    const availability = table["Availability"] ?? "";
    const { price, currency } = parseMoney(table["Price (incl. tax)"] ?? $(".product_main .price_color").text());
    return {
      id,
      title: $(".product_main h1").text().trim(),
      upc: table["UPC"] ?? "",
      category: $(".breadcrumb li").eq(2).text().trim(),
      price,
      price_excl_tax: parseMoney(table["Price (excl. tax)"] ?? "").price,
      tax: parseMoney(table["Tax"] ?? "").price,
      currency,
      rating: parseRating($(".product_main .star-rating").attr("class")),
      in_stock: /in stock/i.test(availability),
      available: Number(/\((\d+) available\)/.exec(availability)?.[1] ?? 0),
      reviews: Number(table["Number of reviews"] ?? 0),
      description: $("#product_description").next("p").text().trim().replace(/\s*\.\.\.more$/, ""),
      image: new URL($("#product_gallery img").attr("src") ?? "", url).href,
      url,
    };
  },
});
