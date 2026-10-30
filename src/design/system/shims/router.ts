/**
 * Stands in for `next/router` (the Pages Router) in a design system's
 * bundle: the root path `/` on every canvas, no query, and navigating
 * (through `useRouter()` or the default `Router`) does nothing.
 */
const noop = (): void => {};

// Takes Next's arguments (a URL, options) and ignores them.
const noopAsync = (..._args: unknown[]): Promise<boolean> =>
  Promise.resolve(true);

export const useRouter = () => ({
  pathname: '/',
  asPath: '/',
  route: '/',
  query: {},
  isReady: true,
  push: noopAsync,
  replace: noopAsync,
  back: noop,
  reload: noop,
  prefetch: noopAsync,
  events: { on: noop, off: noop, emit: noop },
});

const Router = { ...useRouter(), useRouter };

export default Router;
