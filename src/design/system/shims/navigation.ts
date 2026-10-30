/**
 * Stands in for `next/navigation` in a design system's bundle. A canvas has
 * no App Router: the path is the page's own, and navigating does nothing.
 */
export const usePathname = (): string => {
  // No DOM types: this file is also loaded by Node tests, where there's no page.
  const location: unknown = Reflect.get(globalThis, 'location');

  return typeof location === 'object' &&
    location !== null &&
    'pathname' in location &&
    typeof location.pathname === 'string'
    ? location.pathname
    : '/';
};

export const useSearchParams = (): URLSearchParams => new URLSearchParams();

export const useParams = (): Record<string, string> => ({});

export const useSelectedLayoutSegment = (): string | null => null;

export const useSelectedLayoutSegments = (): string[] => [];

const noop = (): void => {};

export const useRouter = () => ({
  push: noop,
  replace: noop,
  back: noop,
  forward: noop,
  refresh: noop,
  prefetch: noop,
});

export const redirect = noop;

export const notFound = noop;
