import { processControls, rereadsOnTick } from '../client/processControls';

const deferred = <T>() => {
  const settle: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((yes) => {
    settle.resolve = yes;
  });

  return { promise, resolve: (value: T) => settle.resolve(value) };
};

const recorder = () => {
  const calls = jest.fn<void, [string, string | null]>();

  return {
    seen: () => calls.mock.calls,
    last: () => calls.mock.calls.filter(([kind]) => kind === 'value').at(-1),
    target: {
      value: (value: string) => calls('value', value),
      error: (message: string | null) => calls('error', message),
    },
  };
};

describe('Settings → Process', () => {
  it('keeps a switch where it was flipped when an older read answers late', async () => {
    const { last, target } = recorder();
    const read = deferred<string>();
    const controls = processControls(
      {
        read: () => read.promise,
        flip: () => Promise.resolve('Research on'),
      },
      target
    );

    const reading = controls.read('prj_pawnee');
    await controls.flip('prj_pawnee', 'planning', 'research', true);
    read.resolve('Research off');
    await reading;

    expect(last()).toEqual(['value', 'Research on']);
  });

  it('clears an earlier error once a flip lands', async () => {
    const { seen, target } = recorder();
    const controls = processControls(
      {
        read: () => Promise.reject(new Error('Leslie’s Mac mini is offline.')),
        flip: () => Promise.resolve('Research on'),
      },
      target
    );

    await controls.read('prj_pawnee');
    await controls.flip('prj_pawnee', 'planning', 'research', true);

    expect(seen()).toEqual([
      ['error', 'Leslie’s Mac mini is offline.'],
      ['error', null],
      ['value', 'Research on'],
    ]);
  });

  it('holds the switches while a flip is on its way, and lets go however it ends', async () => {
    const { target } = recorder();
    const busy = jest.fn<void, [boolean]>();
    const flip = deferred<string>();
    const controls = processControls(
      {
        read: () => Promise.resolve('Research off'),
        flip: () => flip.promise,
      },
      { ...target, busy }
    );

    const flipping = controls.flip('prj_pawnee', 'planning', 'research', true);
    expect(busy.mock.calls).toEqual([[true]]);

    flip.resolve('Research on');
    await flipping;
    expect(busy.mock.calls).toEqual([[true], [false]]);

    const refused = processControls(
      {
        read: () => Promise.resolve('Research off'),
        flip: () => Promise.reject(new Error('Leslie’s Mac mini is offline.')),
      },
      { ...target, busy }
    );
    await refused.flip('prj_pawnee', 'planning', 'research', true);
    expect(busy.mock.calls.at(-1)).toEqual([false]);
  });

  it('reads again on the next heartbeat after an error, unless a flip is on its way', () => {
    // Stuck on "Leslie’s Mac mini is offline." until the runner is back.
    expect(
      rereadsOnTick({ error: 'Leslie’s Mac mini is offline.', busy: false })
    ).toBe(true);
    // Each read is a trip to the computer: not while all is well...
    expect(rereadsOnTick({ error: null, busy: false })).toBe(false);
    // ...nor over a flip, whose answer the newer read would drop.
    expect(
      rereadsOnTick({ error: 'Leslie’s Mac mini is offline.', busy: true })
    ).toBe(false);
  });
});
