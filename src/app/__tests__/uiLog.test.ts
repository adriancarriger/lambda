import { setUiLogSignedIn, startUiLog, uiLog } from '../client/uiLog';

/** Just enough of the browser for `startUiLog`: its timer, kept to call. */
const fakeBrowser = () => {
  const timer: { tick: () => void } = { tick: () => undefined };
  Object.assign(globalThis, {
    window: {
      location: { pathname: '/lambda/dog-park-map' },
      setInterval: (tick: () => void) => {
        timer.tick = tick;

        return 1;
      },
      addEventListener: () => undefined,
    },
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
  });

  return timer;
};

describe('the page’s trail', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    setUiLogSignedIn(false);
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  });

  it('keeps only the newest 500 entries while it can’t send them', async () => {
    const bodies: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.splice(bodies.length, 0, String(init?.body));

      return new Response('{}');
    });
    const timer = fakeBrowser();
    startUiLog();

    // Signed out (the sign-in screen, or after a 401): nothing is sent.
    Array.from({ length: 600 }, (_, n) => uiLog('click', { n }));
    timer.tick();
    expect(bodies).toEqual([]);

    setUiLogSignedIn(true);
    timer.tick();

    const { entries }: { entries: { n: number }[] } = JSON.parse(
      bodies[0] ?? '{}'
    );
    expect(entries).toHaveLength(500);
    expect(entries[0]?.n).toBe(100);
    expect(entries.at(-1)?.n).toBe(599);
  });
});
