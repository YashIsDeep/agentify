export interface HttpCall {
  method: string;
  path: string;
  search: string;
  body: any;
  headers: Record<string, string>;
}

/** Return a plain value for 200 JSON, or a `Response` to control the status. */
export type Route = (call: HttpCall) => unknown;

/**
 * A stand-in for `fetch` so integration adapters can be exercised without a network.
 * Route keys are `"METHOD /path"`; `*` matches one path segment.
 */
export function fakeHttp(routes: Record<string, Route>): { http: typeof fetch; calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  const matchers = Object.entries(routes).map(([key, route]) => {
    const [method, pattern = "/"] = key.split(" ");
    return { method, pattern: new RegExp(`^${pattern.split("*").map(escape).join("[^/]+")}$`), route };
  });

  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: HttpCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      search: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);

    const match = matchers.find((candidate) => candidate.method === call.method && candidate.pattern.test(call.path));
    if (!match) return json({ message: `No fake route for ${call.method} ${call.path}` }, 404);
    const result = match.route(call);
    return result instanceof Response ? result : json(result ?? {});
  };

  return { http, calls };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
