import { AsyncLocalStorage } from "node:async_hooks";

/** A verified marketplace installation, never a Bullrun account or OAuth identity. */
export interface GatewayContext {
  listingId: string;
  installationId?: string;
  deadline: number;
}

const storage = new AsyncLocalStorage<GatewayContext>();

export function runWithGateway<T>(context: GatewayContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getGateway(): GatewayContext | undefined {
  return storage.getStore();
}
