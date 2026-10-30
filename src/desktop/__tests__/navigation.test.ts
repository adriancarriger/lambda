import {
  type GuardedContents,
  decideNavigation,
  guardWindow,
  mayPickFolder,
} from '../navigation';

const ORIGIN = 'http://127.0.0.1:4580';

describe("the window's navigation guard", () => {
  it.each([
    ['https://claude.ai/oauth/authorize?x=1', 'external'],
    ['file:///etc/passwd', 'drop'],
    ['javascript:alert(1)', 'drop'],
    ['lambda://open', 'drop'],
    ['http://example.com/', 'drop'],
    ['http://127.0.0.1:4581/', 'drop'],
    ['not a url', 'drop'],
    [`${ORIGIN}/setup`, 'allow'],
  ])('%s → %s', (url, decision) => {
    expect(decideNavigation(url, ORIGIN)).toBe(decision);
  });

  /** A webContents that keeps each listener by event. */
  const guarded = () => {
    const handlers: {
      navigate?: (event: { preventDefault: () => void }, url: string) => void;
      redirect?: (event: { preventDefault: () => void }, url: string) => void;
      frame?: (details: {
        preventDefault: () => void;
        url: string;
        isMainFrame: boolean;
      }) => void;
      open?: (details: { url: string }) => { action: 'deny' };
    } = {};
    const contents: GuardedContents = {
      on: (
        event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate',
        listener: unknown
      ) => {
        const key = (
          {
            'will-navigate': 'navigate',
            'will-redirect': 'redirect',
            'will-frame-navigate': 'frame',
          } as const
        )[event];
        Object.assign(handlers, { [key]: listener });
      },
      setWindowOpenHandler: (handler) => {
        handlers.open = handler;
      },
    };
    const opened: string[] = [];
    guardWindow(
      contents,
      () => ORIGIN,
      (url) => opened.splice(opened.length, 0, url)
    );

    return { handlers, opened };
  };

  it('stops a redirect or a frame from loading anything but the local origin', () => {
    const { handlers, opened } = guarded();
    const prevented: string[] = [];
    const event = (url: string) => ({
      preventDefault: () => prevented.splice(prevented.length, 0, url),
    });

    handlers.redirect?.(
      event('https://evil.example/'),
      'https://evil.example/'
    );
    handlers.redirect?.(event(`${ORIGIN}/setup`), `${ORIGIN}/setup`);
    handlers.frame?.({
      ...event('https://evil.example/frame'),
      url: 'https://evil.example/frame',
      isMainFrame: false,
    });
    handlers.frame?.({
      ...event(`${ORIGIN}/frame`),
      url: `${ORIGIN}/frame`,
      isMainFrame: false,
    });

    expect(prevented).toEqual([
      'https://evil.example/',
      'https://evil.example/frame',
    ]);
    // Neither is a click: nothing opens in the browser.
    expect(opened).toEqual([]);
  });

  it('keeps a local URL in the window, sends https out, drops the rest, and opens no window', () => {
    const { handlers, opened } = guarded();
    const prevented: string[] = [];
    const navigate = (url: string) =>
      handlers.navigate?.(
        { preventDefault: () => prevented.splice(prevented.length, 0, url) },
        url
      );

    navigate(`${ORIGIN}/tickets`);
    navigate('https://claude.ai/oauth/authorize');
    navigate('file:///etc/passwd');

    expect(prevented).toEqual([
      'https://claude.ai/oauth/authorize',
      'file:///etc/passwd',
    ]);
    expect(handlers.open?.({ url: 'javascript:alert(1)' })).toEqual({
      action: 'deny',
    });
    expect(handlers.open?.({ url: 'https://github.com/x' })).toEqual({
      action: 'deny',
    });
    expect(opened).toEqual([
      'https://claude.ai/oauth/authorize',
      'https://github.com/x',
    ]);
  });

  it('answers the folder picker for the local origin only', () => {
    expect(mayPickFolder(ORIGIN, ORIGIN)).toBe(true);
    expect(mayPickFolder('https://claude.ai', ORIGIN)).toBe(false);
    expect(mayPickFolder(undefined, ORIGIN)).toBe(false);
  });
});
