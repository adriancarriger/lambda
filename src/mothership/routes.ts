import type * as http from 'http';

import { decodePart } from './http';
import type { Session } from './sessions';

export interface RouteContext {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  url: URL;
  /** The pattern's captures, decoded. */
  params: string[];
  session: Session;
}

/**
 * One signed-in route. `sample` is a real path it answers, so a test can walk
 * every route (with no cookie) and see each refused.
 */
export interface Route {
  method: 'GET' | 'POST' | 'HEAD';
  /** An exact path, or a pattern whose groups become `params`. */
  path: string | RegExp;
  sample: string;
  handle: (context: RouteContext) => Promise<void>;
}

export const matchRoute = (
  routes: Route[],
  method: string,
  pathname: string
): { route: Route; params: string[] } | null => {
  const wanted = method === 'HEAD' ? ['HEAD', 'GET'] : [method];

  return routes.reduce<{ route: Route; params: string[] } | null>(
    (found, route) => {
      if (found !== null || !wanted.includes(route.method)) {
        return found;
      }

      if (typeof route.path === 'string') {
        return route.path === pathname ? { route, params: [] } : null;
      }

      const match = route.path.exec(pathname);

      return match === null
        ? null
        : {
            route,
            params: match
              .slice(1)
              .map((part) => decodePart(part ?? '', 'address')),
          };
    },
    null
  );
};
