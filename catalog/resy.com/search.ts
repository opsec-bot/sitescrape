import { z } from "zod";
import { defineEndpoint } from "../../src/endpoint.ts";
import { api, findCity } from "./_shared.ts";

interface Hit {
  id: { resy: number };
  name: string;
  url_slug: string;
  cuisine?: string[];
  neighborhood?: string;
  locality?: string;
  region?: string;
  price_range_id?: number;
  rating?: { average: number; count: number };
  contact?: { phone_number?: string };
  location?: { url_slug?: string };
  _geoloc?: { lat: number; lng: number };
}

interface SearchResponse {
  search: { hits: Hit[] };
  meta: { total: number; page: number; total_pages: number };
}

const venue = z.object({
  id: z.number().int(),
  name: z.string(),
  url: z.string(),
  cuisine: z.array(z.string()),
  neighborhood: z.string().nullable(),
  city: z.string().nullable(),
  price_range: z.number().int().min(0).max(4).nullable().describe("1 = $ ... 4 = $$$$"),
  rating: z.number().nullable(),
  rating_count: z.number().int(),
  phone: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

export default defineEndpoint({
  description: "Search restaurants on Resy by text in a city, with cuisine, neighborhood, price and rating.",
  input: z.object({
    query: z.string().min(1).max(100),
    city: z.string().regex(/^[a-z0-9-]+$/).default("new-york-ny").describe("Resy city slug, e.g. new-york-ny, los-angeles-ca"),
    page: z.number().int().min(1).default(1),
    per_page: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({
    query: z.string(),
    city: z.string(),
    total: z.number().int(),
    page: z.number().int(),
    total_pages: z.number().int(),
    venues: z.array(venue),
  }),
  example: { query: "pizza", city: "new-york-ny", per_page: 5 },
  async run(ctx, { query, city, page, per_page }) {
    const { latitude, longitude } = await findCity(ctx, city);
    const res = await api<SearchResponse>(ctx, "/3/venuesearch/search", {
      method: "POST",
      body: JSON.stringify({
        availability: false,
        page,
        per_page,
        types: ["venue"],
        geo: { latitude, longitude, radius: 16100 },
        query,
      }),
    });
    return {
      query,
      city,
      total: res.meta.total,
      page: res.meta.page,
      total_pages: res.meta.total_pages,
      venues: res.search.hits.map((h) => ({
        id: h.id.resy,
        name: h.name,
        url: `https://resy.com/cities/${h.location?.url_slug ?? city}/venues/${h.url_slug}`,
        cuisine: h.cuisine ?? [],
        neighborhood: h.neighborhood ?? null,
        city: h.locality ?? null,
        price_range: h.price_range_id ?? null,
        rating: h.rating ? Math.round(h.rating.average * 100) / 100 : null,
        rating_count: h.rating?.count ?? 0,
        phone: h.contact?.phone_number ?? null,
        latitude: h._geoloc?.lat ?? null,
        longitude: h._geoloc?.lng ?? null,
      })),
    };
  },
});
