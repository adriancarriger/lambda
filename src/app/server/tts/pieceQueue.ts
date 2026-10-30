/**
 * Rendering scheduled PIECE by piece, by a LIVE priority.
 *
 * A clip is a list of pieces (Kokoro renders ~300 characters per call). Before
 * each piece a worker asks `priorityOf` for every waiting clip and takes the
 * next piece of the most important one — so a click in the app (a jump to a
 * section, another item, another pod) takes effect within one piece, a few
 * seconds at most, and the clip it interrupted resumes later where it left
 * off (its finished pieces are kept). A piece already rendering can't be
 * stopped: the runtime has no cancel, and restarting it means reloading the
 * model (~8 s), which is slower than letting the piece finish.
 *
 * Priorities compare as tuples, lowest first; ties go to the clip queued first.
 */

export type Priority = readonly number[];

interface Job<T> {
  key: string;
  seq: number;
  /** Pieces not yet claimed by a worker, with their place in the clip. */
  pending: { index: number; text: string }[];
  parts: (T | undefined)[];
  inFlight: number;
  failed: boolean;
  resolve: (parts: T[]) => void;
  reject: (error: unknown) => void;
}

export const comparePriority = (a: Priority, b: Priority): number => {
  const length = Math.max(a.length, b.length);
  const diff = Array.from({ length }, (_unused, index) =>
    Math.sign((a[index] ?? 0) - (b[index] ?? 0))
  ).find((sign) => sign !== 0);

  return diff ?? 0;
};

export class CancelledError extends Error {
  constructor(key: string) {
    super(`Cancelled: ${key.slice(0, 60)}`);
    this.name = 'CancelledError';
  }
}

export const createPieceQueue = <T>(
  /** `key`: the clip this piece belongs to (its priority decides how it runs). */
  renderPiece: (piece: string, key: string) => Promise<T>,
  options: {
    workers?: number;
    /** Asked before every piece: how important is this clip right now? */
    priorityOf?: (key: string) => Priority;
  } = {}
) => {
  const workers = options.workers ?? 1;
  const priorityOf = options.priorityOf ?? (() => [0]);
  const jobs: Job<T>[] = [];
  const state = { active: 0, seq: 0 };

  const next = (): Job<T> | undefined =>
    jobs
      .filter((job) => job.pending.length > 0)
      .map((job) => ({ job, priority: priorityOf(job.key) }))
      .sort(
        (a, b) =>
          comparePriority(a.priority, b.priority) || a.job.seq - b.job.seq
      )[0]?.job;

  const remove = (job: Job<T>): void => {
    const at = jobs.indexOf(job);

    if (at !== -1) {
      jobs.splice(at, 1);
    }
  };

  const finish = (job: Job<T>): void => {
    if (job.failed || job.pending.length > 0 || job.inFlight > 0) {
      return;
    }

    remove(job);
    job.resolve(job.parts.filter((part): part is T => part !== undefined));
  };

  const fail = (job: Job<T>, error: unknown): void => {
    if (job.failed) {
      return;
    }

    job.failed = true;
    job.pending = [];
    remove(job);
    job.reject(error);
  };

  const work = async (): Promise<void> => {
    const job = next();
    const piece = job?.pending.shift();

    if (job === undefined || piece === undefined) {
      state.active -= 1;

      return;
    }

    job.inFlight += 1;

    try {
      const part = await renderPiece(piece.text, job.key);
      job.parts[piece.index] = part;
      job.inFlight -= 1;
      finish(job);
    } catch (error) {
      job.inFlight -= 1;
      fail(job, error);
    }

    await work();
  };

  const start = (): void => {
    if (state.active >= workers || next() === undefined) {
      return;
    }

    state.active += 1;
    work().catch(() => {
      state.active -= 1;
    });
    start();
  };

  return {
    /** Queue a clip's pieces; resolves with one result per piece, in order. */
    add: (key: string, pieces: string[]): Promise<T[]> =>
      new Promise<T[]>((resolve, reject) => {
        state.seq += 1;
        const job: Job<T> = {
          key,
          seq: state.seq,
          pending: pieces.map((text, index) => ({ index, text })),
          parts: [],
          inFlight: 0,
          failed: false,
          resolve,
          reject,
        };
        jobs.splice(jobs.length, 0, job);
        // A clip with no pieces (empty text) is done at once.
        finish(job);
        start();
      }),
    /** Drop a clip nobody needs any more (it left the inbox). */
    cancel: (key: string): void => {
      jobs
        .filter((job) => job.key === key)
        .forEach((job) => fail(job, new CancelledError(key)));
    },
    /** Priorities changed (a click): wake a worker if one is idle. */
    poke: (): void => start(),
    /** The clip a worker is on now, and how many clips are waiting. */
    status: (): { current?: string; waiting: number } => ({
      current: jobs.find((job) => job.inFlight > 0)?.key,
      waiting: jobs.filter((job) => job.inFlight === 0).length,
    }),
  };
};
