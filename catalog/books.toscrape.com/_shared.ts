import { z } from "sitescrape";
import type { CheerioAPI } from "cheerio";

export const BASE = "https://books.toscrape.com/catalogue/";

const RATINGS: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };

export const bookCard = z.object({
  id: z.string().describe("Slug used by the book endpoint, e.g. a-light-in-the-attic_1000"),
  title: z.string(),
  price: z.number(),
  currency: z.string(),
  rating: z.number().int().min(0).max(5),
  in_stock: z.boolean(),
  url: z.string(),
  image: z.string(),
});
export type BookCard = z.infer<typeof bookCard>;

export function parseMoney(text: string): { price: number; currency: string } {
  const m = /([^\d\s.,]+)\s*([\d.,]+)/.exec(text.trim());
  if (!m) return { price: Number.NaN, currency: "" };
  return { price: Number(m[2]!.replace(/,/g, "")), currency: m[1]! === "£" ? "GBP" : m[1]! };
}

export function parseRating(className: string | undefined): number {
  const word = (className ?? "").split(/\s+/).find((c) => c in RATINGS);
  return word ? RATINGS[word]! : 0;
}

/** "a-light-in-the-attic_1000/index.html" (relative to /catalogue/) -> "a-light-in-the-attic_1000". */
export function slugFromHref(href: string): string {
  return href.replace(/^(\.\.\/)+/, "").replace(/^catalogue\//, "").replace(/\/index\.html$/, "");
}

export function parseCards($: CheerioAPI, pageUrl: string): BookCard[] {
  return $("article.product_pod")
    .toArray()
    .map((el) => {
      const card = $(el);
      const link = card.find("h3 a");
      const href = link.attr("href") ?? "";
      const id = slugFromHref(href);
      const { price, currency } = parseMoney(card.find(".price_color").text());
      return {
        id,
        title: link.attr("title") ?? link.text().trim(),
        price,
        currency,
        rating: parseRating(card.find(".star-rating").attr("class")),
        in_stock: /in stock/i.test(card.find(".availability").text()),
        url: `${BASE}${id}/index.html`,
        image: new URL(card.find("img").attr("src") ?? "", pageUrl).href,
      };
    });
}

/** "Page 3 of 50" -> 50. A page with no pager is the only page. */
export function parseTotalPages($: CheerioAPI): number {
  const m = /of\s+(\d+)/i.exec($(".pager .current").text());
  return m ? Number(m[1]) : 1;
}

export const pageUrl = (page: number) => `${BASE}page-${page}.html`;
