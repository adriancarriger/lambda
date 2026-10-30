import {
  CancelledError,
  type Priority,
  comparePriority,
  createPieceQueue,
} from '../server/tts/pieceQueue';

/**
 * A renderer whose pieces finish only when the test says so, and whose
 * priorities the test sets — like a click in the app would.
 */
const manual = (workers = 1) => {
  const order: string[] = [];
  const pending: { piece: string; finish: () => void; fail: () => void }[] = [];
  const priorities = new Map<string, Priority>();
  const queue = createPieceQueue(
    (piece: string) =>
      new Promise<string>((resolve, reject) => {
        order.splice(order.length, 0, piece);
        pending.splice(pending.length, 0, {
          piece,
          finish: () => resolve(piece.toUpperCase()),
          fail: () => reject(new Error(`failed ${piece}`)),
        });
      }),
    {
      workers,
      priorityOf: (key) => priorities.get(key) ?? [9],
    }
  );
  const flush = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));
  /** Finish the piece rendering longest, then let the worker pick again. */
  const step = async (): Promise<void> => {
    pending.shift()?.finish();
    await flush();
  };

  return { queue, order, pending, priorities, step, flush };
};

describe('comparePriority', () => {
  it('compares tuples, lowest first', () => {
    expect(comparePriority([0, -5], [1, 0])).toBeLessThan(0);
    expect(comparePriority([2, 3], [2, 1])).toBeGreaterThan(0);
    expect(comparePriority([3], [3])).toBe(0);
  });
});

describe('createPieceQueue — a live priority, decided before every piece', () => {
  it('a click mid-clip takes effect at the next piece; the interrupted clip resumes', async () => {
    const { queue, order, priorities, step, flush } = manual();
    priorities.set('other-pod', [2, 5]);

    const background = queue.add('other-pod', ['b1', 'b2', 'b3']);
    await flush();
    // The owner jumps to a section: it becomes the most important clip.
    priorities.set('jump', [0, -1]);
    const jump = queue.add('jump', ['j1', 'j2']);

    await step(); // b1 was already rendering: it finishes
    await step(); // j1
    await step(); // j2
    await expect(jump).resolves.toEqual(['J1', 'J2']);

    await step(); // b2 — the background clip picks up where it stopped
    await step(); // b3
    await expect(background).resolves.toEqual(['B1', 'B2', 'B3']);
    expect(order).toEqual(['b1', 'j1', 'j2', 'b2', 'b3']);
  });

  it('re-reads priorities each piece: changing them re-orders queued work', async () => {
    const { queue, order, priorities, step, flush } = manual();
    priorities.set('a', [2, 1]);
    priorities.set('b', [2, 2]);

    queue.add('a', ['a1', 'a2']).catch(() => undefined);
    queue.add('b', ['b1']).catch(() => undefined);
    await flush();
    // They open b's item: b now outranks a.
    priorities.set('b', [2, 0]);
    queue.poke();

    await step();
    await step();
    await step();
    expect(order).toEqual(['a1', 'b1', 'a2']);
  });

  it('ties go to the clip queued first', async () => {
    const { queue, order, step, flush } = manual();

    queue.add('first', ['f1']).catch(() => undefined);
    queue.add('second', ['s1']).catch(() => undefined);
    await flush();
    await step();
    await step();
    expect(order).toEqual(['f1', 's1']);
  });

  it('cancel drops a clip nobody needs, even part-rendered', async () => {
    const { queue, order, step, flush } = manual();

    const gone = queue.add('gone', ['g1', 'g2']);
    const kept = queue.add('kept', ['k1']);
    await flush();
    queue.cancel('gone');
    await expect(gone).rejects.toBeInstanceOf(CancelledError);
    await step(); // g1 was already rendering; its result is thrown away
    await step();
    await expect(kept).resolves.toEqual(['K1']);
    expect(order).toEqual(['g1', 'k1']);
  });

  it('two workers render two pieces at once, and keep each clip in order', async () => {
    const { queue, pending, flush } = manual(2);

    const clip = queue.add('clip', ['p1', 'p2', 'p3']);
    await flush();
    expect(pending.map((entry) => entry.piece)).toEqual(['p1', 'p2']);

    // p2 finishes before p1: the clip still comes back in order.
    pending[1]?.finish();
    await flush();
    pending[0]?.finish();
    await flush();
    pending[2]?.finish();
    await expect(clip).resolves.toEqual(['P1', 'P2', 'P3']);
  });

  it('a failed piece rejects only its own clip', async () => {
    const { queue, pending, step, flush } = manual();

    const broken = queue.add('broken', ['x1', 'x2']);
    const fine = queue.add('fine', ['ok']);
    await flush();
    pending.shift()?.fail();
    await expect(broken).rejects.toThrow('failed x1');
    await flush();
    await step();
    await expect(fine).resolves.toEqual(['OK']);
  });

  it('reports what it is on and how much waits', async () => {
    const { queue, flush } = manual();

    queue.add('a', ['a1']).catch(() => undefined);
    queue.add('b', ['b1']).catch(() => undefined);
    await flush();
    expect(queue.status()).toEqual({ current: 'a', waiting: 1 });
  });

  it("tells the renderer which clip each piece is for (Kokoro's CPU tier)", async () => {
    const seen: string[] = [];
    const queue = createPieceQueue(
      async (piece: string, key: string) => {
        seen.splice(seen.length, 0, `${key}:${piece}`);

        return piece;
      },
      { priorityOf: () => [0] }
    );

    await queue.add('waiting-on', ['w1', 'w2']);
    expect(seen).toEqual(['waiting-on:w1', 'waiting-on:w2']);
  });
});
