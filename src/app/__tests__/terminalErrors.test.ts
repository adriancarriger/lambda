import { ServerError, api } from '../client/api';
import { terminalErrors } from '../client/terminalErrors';

const OFFLINE = 'Leslie’s Mac mini is offline.';

const reporter = () => {
  const report = jest.fn<void, [unknown]>();

  return {
    errors: terminalErrors(report),
    said: () =>
      report.mock.calls.map(([caught]) =>
        caught instanceof Error ? caught.message : String(caught)
      ),
  };
};

describe('the terminal’s failures', () => {
  it('says a keystroke didn’t reach an offline computer', () => {
    const { errors, said } = reporter();

    errors.keys(new ServerError(409, OFFLINE));

    expect(said()).toEqual([OFFLINE]);
  });

  it('says a poll that the server refused, once until a frame lands again', () => {
    const { errors, said } = reporter();

    errors.poll(new ServerError(409, OFFLINE));
    errors.poll(new ServerError(409, OFFLINE));
    errors.poll(new ServerError(504, 'No answer from Leslie’s Mac mini.'));
    expect(said()).toEqual([OFFLINE]);

    errors.polled();
    errors.poll(new ServerError(409, OFFLINE));
    expect(said()).toEqual([OFFLINE, OFFLINE]);
  });

  it('keeps quiet, holding the last frame, when the window is gone', () => {
    const { errors, said } = reporter();

    // The runner's own answer: tmux has no such window (fork closed).
    errors.poll(new ServerError(400, "can't find window: fork-q4"));
    // The request died on the way: the page's own state stream says so.
    errors.poll(
      new Error("The inbox server didn't answer /api/term (HTTP 502)")
    );

    expect(said()).toEqual([]);
  });
});

describe('a read the server refused', () => {
  afterEach(() => jest.restoreAllMocks());

  it('carries the server’s words and status, not “Unexpected response”', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: OFFLINE }), {
        status: 409,
      })
    );

    const caught = await api.term('pod_pawnee', 'dev').catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ServerError);
    expect(caught).toMatchObject({ status: 409, message: OFFLINE });
  });
});
