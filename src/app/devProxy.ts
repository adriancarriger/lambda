/** Vite's own page in development: `vite.config.mts`'s server port. */
export const DEV_PAGE_ORIGINS = [
  'http://localhost:4581',
  'http://127.0.0.1:4581',
];

/**
 * The Origin the dev proxy sends on to the mothership. Its own page is
 * presented as the mothership's (or the Origin check refuses every POST);
 * any other origin goes through unchanged, so the mothership refuses it as
 * it would without the proxy.
 */
export const proxiedOrigin = (
  origin: string | undefined,
  mothership: string
): string | undefined =>
  origin !== undefined && DEV_PAGE_ORIGINS.includes(origin)
    ? mothership
    : origin;
