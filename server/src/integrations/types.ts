import type { ConnectionField, ConnectionType } from "@wm/shared";

/** The values a connection holds, secrets included. Never leaves the server. */
export type ConnectionValues = Record<string, string>;

/** Injected so tests can answer requests without a network. */
export type HttpFetch = typeof fetch;

/**
 * One remote service. The adapter owns everything service-specific: which fields the
 * connection needs, how to authenticate, and what a cheap "are these credentials good?"
 * call looks like.
 */
export interface ConnectionAdapter<Client> {
  type: ConnectionType;
  label: string;
  description: string;
  docsUrl: string;
  fields: ConnectionField[];
  client(values: ConnectionValues, http: HttpFetch): Client;
  /** Authenticates and returns who we are, for the Test button. */
  test(client: Client): Promise<string>;
}

export type AnyConnectionAdapter = ConnectionAdapter<any>;
