import { ServerError } from '../client/api';
import { untilFound } from '../client/untilFound';

const noWait = async (): Promise<void> => undefined;

describe("a just-made pod's page", () => {
  it('asks again while the server has no such pod yet, then shows it', async () => {
    const get = jest
      .fn<Promise<{ id: string }>, []>()
      .mockRejectedValueOnce(new ServerError(404, 'No pod ice-town-1a2b'))
      .mockRejectedValueOnce(new ServerError(404, 'No pod ice-town-1a2b'))
      .mockResolvedValueOnce({ id: 'ice-town-1a2b' });

    await expect(untilFound(get, { wait: noWait })).resolves.toEqual({
      id: 'ice-town-1a2b',
    });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('gives up after its tries, with the 404 itself', async () => {
    const get = jest.fn(() =>
      Promise.reject(new ServerError(404, 'No pod ice-town-1a2b'))
    );

    await expect(untilFound(get, { tries: 3, wait: noWait })).rejects.toThrow(
      'No pod ice-town-1a2b'
    );
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('fails at once on anything else', async () => {
    const get = jest.fn(() =>
      Promise.reject(new ServerError(409, "Leslie's Mac mini is offline."))
    );

    await expect(untilFound(get, { wait: noWait })).rejects.toThrow('offline');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
