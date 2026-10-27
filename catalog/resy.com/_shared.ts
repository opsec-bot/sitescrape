import type { Context } from "../../src/context.ts";
import { EndpointError } from "../../src/endpoint.ts";

export const API = "https://api.resy.com";
const SITE = "https://resy.com/";

// resy's web app ships a public client key in its main bundle. Read it at runtime instead of
// committing it, and cache it for the life of the process.
let apiKey: Promise<string> | undefined;

export function getApiKey(ctx: Context): Promise<string> {
  apiKey ??= (async () => {
    const html = await ctx.text(SITE);
    const bundle = /src="(modules\/app\.[\w]+\.js)"/.exec(html)?.[1];
    if (!bundle) throw new EndpointError("could not find resy app bundle on homepage", "upstream");
    const js = await ctx.text(new URL(bundle, SITE).href);
    const key = /apiKey:"(\w{16,})"/.exec(js)?.[1];
    if (!key) throw new EndpointError("could not find api key in resy app bundle", "upstream");
    return key;
  })().catch((err) => {
    apiKey = undefined;
    throw err;
  });
  return apiKey;
}

/** For tests: forget the cached key and city list. */
export function resetCache(): void {
  apiKey = undefined;
  cities = undefined;
}

export async function api<T>(ctx: Context, path: string, init: RequestInit = {}): Promise<T> {
  const key = await getApiKey(ctx);
  return ctx.json<T>(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `ResyAPI api_key="${key}"`,
      accept: "application/json, text/plain, */*",
      origin: "https://resy.com",
      "x-origin": "https://resy.com",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export interface City {
  url_slug: string;
  name: string;
  latitude: number;
  longitude: number;
}

let cities: Promise<City[]> | undefined;

/** All resy cities. The list is ~2 MB, so it is fetched once per process. */
export function getCities(ctx: Context): Promise<City[]> {
  cities ??= api<City[]>(ctx, "/3/location/config?lat=40.7128&long=-74.006").catch((err) => {
    cities = undefined;
    throw err;
  });
  return cities;
}

export async function findCity(ctx: Context, slug: string): Promise<City> {
  const city = (await getCities(ctx)).find((c) => c.url_slug === slug);
  if (!city) throw new EndpointError(`unknown resy city "${slug}", e.g. new-york-ny`, "not_found");
  return city;
}
