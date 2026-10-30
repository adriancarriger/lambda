/**
 * What the Mac app's window may load. Only the local mothership's origin
 * stays in the window; any other `https:` link opens in the default browser;
 * every other scheme (`file:`, `javascript:`, custom ones) is dropped.
 */

export type NavigationDecision = 'allow' | 'external' | 'drop';

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

export const localOrigin = (port: number): string => `http://127.0.0.1:${port}`;

export const isLocalOrigin = (url: string, origin: string): boolean =>
  parse(url)?.origin === origin;

export const decideNavigation = (
  url: string,
  origin: string
): NavigationDecision => {
  const parsed = parse(url);

  if (parsed === null) {
    return 'drop';
  }

  if (parsed.origin === origin) {
    return 'allow';
  }

  return parsed.protocol === 'https:' ? 'external' : 'drop';
};

/** The bits of Electron's webContents the guard uses. */
export interface GuardedContents {
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault: () => void }, url: string) => void
  ): unknown;
  on(
    event: 'will-redirect',
    listener: (event: { preventDefault: () => void }, url: string) => void
  ): unknown;
  on(
    event: 'will-frame-navigate',
    listener: (details: {
      preventDefault: () => void;
      url: string;
      isMainFrame: boolean;
    }) => void
  ): unknown;
  setWindowOpenHandler: (
    handler: (details: { url: string }) => { action: 'deny' }
  ) => void;
}

/**
 * The window never navigates away from the local origin and never opens a
 * second window: a link elsewhere goes to `openExternal` when it's https. A
 * server redirect or a frame can't load anywhere else either; neither is a
 * click, so neither opens the browser.
 */
export const guardWindow = (
  contents: GuardedContents,
  origin: () => string,
  openExternal: (url: string) => void
): void => {
  const route = (url: string): boolean => {
    const decision = decideNavigation(url, origin());

    if (decision === 'external') {
      openExternal(url);
    }

    return decision === 'allow';
  };

  contents.on('will-navigate', (event, url) => {
    if (!route(url)) {
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (decideNavigation(url, origin()) !== 'allow') {
      event.preventDefault();
    }
  });
  // The main frame is will-navigate's; this catches iframes.
  contents.on('will-frame-navigate', (details) => {
    if (
      !details.isMainFrame &&
      decideNavigation(details.url, origin()) !== 'allow'
    ) {
      details.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    route(url);

    return { action: 'deny' };
  });
};

/** The folder picker answers only the local origin's own frame. */
export const mayPickFolder = (
  senderOrigin: string | undefined,
  origin: string
): boolean => senderOrigin === origin;
