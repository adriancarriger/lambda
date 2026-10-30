import { waitForClip } from '../client/clipWait';

/** The player waits for Kokoro, never for a timer, and never switches voice. */

const options = (
  overrides: Partial<Parameters<typeof waitForClip>[1]> = {}
) => ({
  again: jest.fn(async () => null),
  retries: 2,
  gapMs: 3_000,
  sleep: jest.fn(async () => undefined),
  cancelled: () => false,
  ...overrides,
});

describe('waitForClip', () => {
  it('waits however long the render takes (no timeout)', async () => {
    const slow = new Promise<string | null>((resolve) => {
      setTimeout(() => resolve('clip.mp3'), 50);
    });
    const args = options();

    await expect(waitForClip(slow, args)).resolves.toBe('clip.mp3');
    expect(args.again).not.toHaveBeenCalled();
    expect(args.sleep).not.toHaveBeenCalled();
  });

  it('asks again when a clip comes back unavailable', async () => {
    const again = jest
      .fn<Promise<string | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('clip.mp3');
    const args = options({ again });

    await expect(waitForClip(Promise.resolve(null), args)).resolves.toBe(
      'clip.mp3'
    );
    expect(again).toHaveBeenCalledTimes(2);
    expect(args.sleep).toHaveBeenCalledWith(3_000);
  });

  it('gives up (null) after its retries, rather than another voice', async () => {
    const args = options();

    await expect(waitForClip(Promise.resolve(null), args)).resolves.toBeNull();
    expect(args.again).toHaveBeenCalledTimes(2);
  });

  it('stops asking once the listener has moved on', async () => {
    const state = { moved: false };
    const args = options({
      sleep: jest.fn(async () => {
        state.moved = true;
      }),
      cancelled: () => state.moved,
    });

    await expect(waitForClip(Promise.resolve(null), args)).resolves.toBeNull();
    expect(args.again).not.toHaveBeenCalled();
  });
});
