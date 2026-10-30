import { waitingFailureNote } from '../shared/waitingNote';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

describe("a waiting pod's failed start", () => {
  it('says why, and when Lambda tries again', () => {
    expect(
      waitingFailureNote(
        {
          error: "Leslie's MacBook didn't answer. Try again.",
          retryAt: new Date(NOW + 4 * 60_000 + 10_000).toISOString(),
        },
        NOW
      )
    ).toBe(
      "Didn't start: Leslie's MacBook didn't answer. Try again. Lambda tries again in 5 min."
    );
  });

  it('ends the reason with a full stop, once', () => {
    expect(
      waitingFailureNote(
        {
          error: 'lambda pod new exited 1',
          retryAt: new Date(NOW + 60_000).toISOString(),
        },
        NOW
      )
    ).toBe(
      "Didn't start: lambda pod new exited 1. Lambda tries again in 1 min."
    );
  });

  it('says it is trying again once the wait is over', () => {
    expect(
      waitingFailureNote(
        {
          error: 'lambda pod new exited 1',
          retryAt: new Date(NOW - 1000).toISOString(),
        },
        NOW
      )
    ).toBe("Didn't start: lambda pod new exited 1. Trying again now.");
  });

  it('never says "NaN min" or an empty reason', () => {
    expect(waitingFailureNote({ error: '  ', retryAt: 'soon' }, NOW)).toBe(
      "Didn't start, for no reason given. Lambda tries again shortly."
    );
  });
});
