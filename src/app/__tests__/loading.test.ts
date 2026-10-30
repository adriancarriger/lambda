import { errorText, latestLoader } from '../client/loading';

const deferred = <T>() => {
  const settle: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((yes) => {
    settle.resolve = yes;
  });

  return { promise, resolve: (value: T) => settle.resolve(value) };
};

/** Every call to the page's setters, in order. */
const recorder = () => {
  const calls = jest.fn<void, [string, string | null]>();

  return {
    seen: () => calls.mock.calls,
    target: {
      value: (value: string) => calls('value', value),
      error: (message: string | null) => calls('error', message),
    },
  };
};

describe('loading a page’s data', () => {
  it('drops a slower answer to an older request', async () => {
    const { seen, target } = recorder();
    const load = latestLoader(target);
    const pawnee = deferred<string>();
    const sweetums = deferred<string>();

    const first = load(pawnee.promise);
    const second = load(sweetums.promise);
    sweetums.resolve('Sweetums recipe app');
    await second;
    pawnee.resolve('Pawnee Parks site');
    await first;

    expect(seen()).toEqual([
      ['error', null],
      ['value', 'Sweetums recipe app'],
    ]);
  });

  it('clears an earlier error once a request succeeds', async () => {
    const { seen, target } = recorder();
    const load = latestLoader(target);

    await load(Promise.reject(new Error('Leslie’s Mac mini is offline.')));
    await load(Promise.resolve('Pawnee Parks site'));

    expect(seen()).toEqual([
      ['error', 'Leslie’s Mac mini is offline.'],
      ['error', null],
      ['value', 'Pawnee Parks site'],
    ]);
  });

  it('shows an error’s message, not "Error: …"', () => {
    expect(errorText(new Error('Leslie’s Mac mini is offline.'))).toBe(
      'Leslie’s Mac mini is offline.'
    );
    expect(errorText('no such pod')).toBe('no such pod');
  });
});
