import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import book from "../catalog/books.toscrape.com/book.ts";
import list from "../catalog/books.toscrape.com/list.ts";
import search from "../catalog/books.toscrape.com/search.ts";
import { Context } from "../src/context.ts";
import { EndpointError, invoke } from "../src/endpoint.ts";
import { loadCatalog } from "../src/registry.ts";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");

/** Serves saved pages: page-1 and page-50 are real, every other page reuses page-50's markup. */
function siteContext() {
  const requested: string[] = [];
  const ctx = new Context({
    fetch: async (url) => {
      requested.push(url);
      if (url.endsWith("/a-light-in-the-attic_1000/index.html")) return new Response(fixture("books-detail.html"));
      if (url.endsWith("/page-1.html")) return new Response(fixture("books-page-1.html"));
      if (/\/page-\d+\.html$/.test(url)) return new Response(fixture("books-page-50.html"));
      return new Response("", { status: 404 });
    },
  });
  return { ctx, requested };
}

describe("books.toscrape.com", () => {
  it("list parses a catalogue page", async () => {
    const out = (await invoke(list, siteContext().ctx, { page: 1 })) as any;
    expect(out.total_pages).toBe(50);
    expect(out.books).toHaveLength(20);
    expect(out.books[0]).toEqual({
      id: "a-light-in-the-attic_1000",
      title: "A Light in the Attic",
      price: 51.77,
      currency: "GBP",
      rating: 3,
      in_stock: true,
      url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
      image: "https://books.toscrape.com/media/cache/2c/da/2cdad67c44b002e7ead0cc35693c0e8b.jpg",
    });
  });

  it("search scans every page until it has enough results", async () => {
    const { ctx, requested } = siteContext();
    const out = (await invoke(search, ctx, { query: "LIGHT IN THE ATTIC" })) as any;
    expect(out.results.map((b: any) => b.id)).toEqual(["a-light-in-the-attic_1000"]);
    // one hit is below the default limit of 10, so all 50 pages get scanned
    expect(requested).toHaveLength(50);

    const second = siteContext();
    await invoke(search, second.ctx, { query: "a", limit: 3 });
    expect(second.requested).toHaveLength(1);
  });

  it("book parses the detail page", async () => {
    const out = (await invoke(book, siteContext().ctx, { id: "a-light-in-the-attic_1000" })) as any;
    expect(out).toMatchObject({ title: "A Light in the Attic", upc: "a897fe39b1053632", category: "Poetry", available: 22, rating: 3 });
    expect(out.description).toMatch(/^It's hard to imagine/);
    expect(out.description).not.toMatch(/\.\.\.more$/);
  });

  it("rejects bad ids before any request", async () => {
    const { ctx, requested } = siteContext();
    await expect(invoke(book, ctx, { id: "../../etc" })).rejects.toMatchObject({ code: "bad_input" });
    expect(requested).toHaveLength(0);
  });

  it("reports schema drift when the page layout changes", async () => {
    const ctx = new Context({ fetch: async () => new Response("<html><body>redesigned</body></html>") });
    const err: any = await invoke(list, ctx, { page: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(EndpointError);
    expect(err.code).toBe("bad_output");
  });

  it("is discovered by the catalog loader", async () => {
    const ids = (await loadCatalog(path.join(import.meta.dirname, "..", "catalog"))).map((e) => e.id);
    expect(ids.filter((id) => id.startsWith("books.toscrape.com/"))).toEqual([
      "books.toscrape.com/book",
      "books.toscrape.com/list",
      "books.toscrape.com/search",
    ]);
  });
});
