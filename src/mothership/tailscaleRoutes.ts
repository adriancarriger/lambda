import {
  type ListenFields,
  type TailscaleCheck,
  checkTailscale,
  joinServer,
  listenFields,
  saveListenFields,
  stepOneText,
} from '../runner/tailscale';
import { json } from './http';
import { HttpError } from './relay';
import type { Route } from './routes';

/**
 * Add a computer over Tailscale: the page asks the mothership to check
 * Tailscale here and to listen on this computer's tailnet address. Neither
 * takes an address from the request: only what `tailscale status --json`
 * reports is ever listened on or saved.
 */

export interface NetworkControl {
  /** `tailscale status --json` on this computer, read. */
  tailscale: () => Promise<TailscaleCheck>;
  /** Listen on one more address now; rejects with the line to show. */
  listenOn: (address: string) => Promise<void>;
  /** Write `mothership.listen` (and `host`) to ~/.lambda/config.json. */
  save: (fields: ListenFields) => void;
}

/** Until main hands in its listeners, nothing more is listened on. */
export const defaultNetwork = (): NetworkControl => ({
  tailscale: () => checkTailscale(),
  listenOn: async () => {
    throw new HttpError(503, "This Lambda can't add an address to listen on.");
  },
  save: (fields) => saveListenFields(fields),
});

export const createTailscaleRoutes = (context: {
  network: NetworkControl;
  port: number;
  /** After the write: the Host check reads the new name at once. */
  configChanged: () => void;
}): Route[] => [
  {
    method: 'GET',
    path: '/api/computers/tailscale',
    sample: '/api/computers/tailscale',
    handle: async ({ response }) => {
      const check = await context.network.tailscale();
      json(response, 200, {
        step: stepOneText(check),
        state: check.state,
        ...(check.state === 'up'
          ? { address: check.address, label: check.label }
          : {}),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/computers/tailscale/listen',
    sample: '/api/computers/tailscale/listen',
    handle: async ({ response }) => {
      const check = await context.network.tailscale();

      if (check.state !== 'up') {
        throw new HttpError(409, stepOneText(check));
      }

      // Bound before it is saved: a refused address is never written.
      await context.network.listenOn(check.address).catch((error: unknown) => {
        throw error instanceof HttpError
          ? error
          : new HttpError(
              409,
              error instanceof Error ? error.message : String(error)
            );
      });
      context.network.save(listenFields(check));
      context.configChanged();
      json(response, 200, {
        ok: true,
        result: { server: joinServer(check, context.port) },
      });
    },
  },
];
