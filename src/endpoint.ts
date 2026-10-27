import type { z } from "zod";
import type { Context } from "./context.ts";

export interface EndpointDef<I extends z.ZodType, O extends z.ZodType> {
  /** One line, shown in `sitescrape list` and as the MCP tool description. */
  description: string;
  /** "read" endpoints only fetch data. "action" endpoints change something on the site. */
  kind?: "read" | "action";
  /** Needs a saved login (`sitescrape login <url>`). Cookies and the sticky proxy IP are loaded and saved around each call. */
  session?: boolean;
  input: I;
  output: O;
  /** Input used by `sitescrape probe` to check the endpoint still works. */
  example: z.input<I>;
  /** Page to re-record when `sitescrape heal` repairs this endpoint. Defaults to the site's homepage. */
  source?: string;
  run(ctx: Context, input: z.output<I>): Promise<z.input<O>>;
}

export interface Endpoint<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType>
  extends EndpointDef<I, O> {
  kind: "read" | "action";
}

export function defineEndpoint<I extends z.ZodType, O extends z.ZodType>(
  def: EndpointDef<I, O>,
): Endpoint<I, O> {
  return { kind: "read", ...def };
}

export type ErrorCode = "bad_input" | "bad_output" | "upstream" | "not_found" | "auth_required" | "config";

export class EndpointError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

/** Validate input, run the endpoint, validate output. Output drift means the site changed. */
export async function invoke(endpoint: Endpoint, ctx: Context, rawInput: unknown): Promise<unknown> {
  const input = endpoint.input.safeParse(rawInput ?? {});
  if (!input.success) throw new EndpointError("input does not match schema", "bad_input", input.error.issues);
  const result = await endpoint.run(ctx, input.data);
  const output = endpoint.output.safeParse(result);
  if (!output.success) {
    throw new EndpointError("site response no longer matches schema", "bad_output", output.error.issues);
  }
  return output.data;
}
