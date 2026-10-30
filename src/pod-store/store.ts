import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { type z } from 'zod';

import {
  type AskThread,
  AskThreadSchema,
  type AutonomousDecision,
  AutonomousDecisionSchema,
  type BuildingState,
  BuildingStateSchema,
  type DeliveryEvent,
  DeliveryEventSchema,
  type DeliveryStatus,
  type Fork,
  ForkSchema,
  type HumanDecision,
  HumanDecisionSchema,
  ID_PATTERN,
  type Inbox,
  InboxSchema,
  type Pod,
  PodSchema,
  type Question,
  QuestionSchema,
  RequestSchema,
  type Screenshot,
  ScreenshotManifestSchema,
  type StepEvent,
  StepEventSchema,
  type ThreadEntry,
  ThreadEntrySchema,
  type ThreadMessage,
  type Turn,
  TurnSchema,
  type WorkRequest,
} from './schemas';

/**
 * File layout under the pods root (`<project>/.lambda/pods` by default):
 *
 *   _inbox.json                     app-owned: pod priority order
 *   <id>/pod.json                   pod record
 *   <id>/intent.md                  the owner's words + derived principles (agent-written)
 *   <id>/settings.json              agent launch settings (written by `lambda pod new`)
 *   <id>/questions/<qid>.json       one file per question
 *   <id>/versions/<qid>/<n>.json    earlier versions of a checkpoint card
 *   <id>/thread.jsonl               append-only messages
 *   <id>/delivery.jsonl             append-only delivered/received marks for thread messages
 *   <id>/human-decisions.jsonl      append-only
 *   <id>/autonomous-decisions.jsonl append-only
 *   <id>/forks/<qid>.json           conversation forks
 *   <id>/turns/<agent>.json         sent/started/ended timestamps per agent
 *   <id>/building.json              a building pod's ticket runs and watches
 *   <id>/screenshots/<ticket>/<n>/  qa's test screenshots + manifest.json
 *   <id>/asks/<thread>.json         the Product manager's read-only forks
 *
 * Mutable records (pod, questions, forks, turns) are written atomically
 * (temp file + rename). Everything else is append-only JSONL, so the CLI and the
 * app never rewrite a file the other may be appending to — delivery status lives
 * in its own log rather than being patched into thread.jsonl.
 */

export class PodScopeError extends Error {}

export const newId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

export const nowIso = (): string => new Date().toISOString();

const assertId = (value: string, what: string): string => {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${what} "${value}"`);
  }

  return value;
};

/** A ticket id as a folder name: letters, digits, - and _ (any case). */
const assertTicketFolder = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ticket id "${value}"`);
  }

  return value;
};

export const writeJsonAtomic = (file: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
};

const readJson = <T>(
  file: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): T | null => {
  if (!fs.existsSync(file)) {
    return null;
  }

  return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
};

const appendJsonl = (file: string, data: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(data)}\n`);
};

const readJsonl = <T>(
  file: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): T[] => {
  if (!fs.existsSync(file)) {
    return [];
  }

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => schema.parse(JSON.parse(line)));
};

const foldDelivery = (
  entry: ThreadEntry,
  events: DeliveryEvent[]
): DeliveryStatus => {
  const mine = events.filter((event) => event.msgId === entry.id);

  if (mine.some((event) => event.status === 'received')) {
    return 'received';
  }

  if (mine.some((event) => event.status === 'delivered')) {
    return 'delivered';
  }

  return entry.wire === undefined ? 'received' : 'pending';
};

export interface PodStoreOptions {
  /** When set, every operation on a different pod throws PodScopeError. */
  scopePodId?: string;
  /** How long updateBuilding waits for the lock, and when a held one is dead. */
  buildingLock?: { timeoutMs?: number; staleMs?: number };
}

const BUILDING_LOCK_TIMEOUT_MS = 10_000;
/** Well past any read-patch-write: a lock this old was left by a dead writer. */
const BUILDING_LOCK_STALE_MS = 30_000;
const BUILDING_LOCK_RETRY_MS = 20;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const isFsCode = (error: unknown, code: string): boolean =>
  // Not `instanceof Error`: fs errors can come from another realm.
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

const readLock = (lock: string): string | undefined => {
  try {
    return fs.readFileSync(lock, 'utf8');
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
};

/**
 * Move a dead writer's lock aside: a rename is atomic, so of two writers
 * that both saw it stale only one moves it. A lock that isn't the one seen
 * stale (another writer took over first) is put back.
 */
const takeOver = (lock: string, seen: string): void => {
  const aside = `${lock}.${randomBytes(6).toString('hex')}`;

  try {
    fs.renameSync(lock, aside);
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) {
      return;
    }

    throw error;
  }

  if (readLock(aside) !== seen) {
    try {
      fs.linkSync(aside, lock);
    } catch (error) {
      if (!isFsCode(error, 'EEXIST')) {
        throw error;
      }
    }
  }
  fs.rmSync(aside, { force: true });
};

/** One go at `<file>.lock` (O_EXCL): our token, or false while another writer holds it. */
export const tryLock = (lock: string, staleMs: number): string | false => {
  const token = `${process.pid} ${randomBytes(6).toString(
    'hex'
  )} ${nowIso()}\n`;

  try {
    fs.writeFileSync(lock, token, { flag: 'wx' });

    return token;
  } catch (error) {
    if (!isFsCode(error, 'EEXIST')) {
      throw error;
    }
  }

  const seen = readLock(lock);
  const heldFor = (() => {
    try {
      return Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      // Released between the write and the stat: try again now.
      return undefined;
    }
  })();

  if (seen === undefined || heldFor === undefined) {
    return tryLock(lock, staleMs);
  }

  if (heldFor <= staleMs) {
    return false;
  }
  takeOver(lock, seen);

  return tryLock(lock, staleMs);
};

/** Only our own lock: another writer may have taken over a slow one. */
export const releaseLock = (lock: string, token: string): void => {
  if (readLock(lock) === token) {
    fs.rmSync(lock, { force: true });
  }
};

const lockTimeout = (file: string, timeoutMs: number): Error =>
  new Error(
    `Could not lock ${file} within ${timeoutMs}ms: another writer holds ${file}.lock.`
  );

/**
 * Hold `<file>.lock` while `work` runs, so writers in other processes take
 * turns. A lock older than `staleMs` is taken over; one still held after
 * `timeoutMs` throws rather than writing over it.
 */
export const withFileLock = <T>(
  file: string,
  limits: { timeoutMs: number; staleMs: number },
  work: () => T
): T => {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + limits.timeoutMs;

  const acquire = (): string => {
    const token = tryLock(lock, limits.staleMs);

    if (token !== false) {
      return token;
    }

    if (Date.now() > deadline) {
      throw lockTimeout(file, limits.timeoutMs);
    }
    sleepSync(BUILDING_LOCK_RETRY_MS);

    return acquire();
  };
  const token = acquire();

  try {
    return work();
  } finally {
    releaseLock(lock, token);
  }
};

/** withFileLock for the long-lived runner: waiting never blocks its event loop. */
const withFileLockAsync = async <T>(
  file: string,
  limits: { timeoutMs: number; staleMs: number },
  work: () => T
): Promise<T> => {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + limits.timeoutMs;

  const acquire = async (): Promise<string> => {
    const token = tryLock(lock, limits.staleMs);

    if (token !== false) {
      return token;
    }

    if (Date.now() > deadline) {
      throw lockTimeout(file, limits.timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, BUILDING_LOCK_RETRY_MS));

    return acquire();
  };
  const token = await acquire();

  try {
    return work();
  } finally {
    releaseLock(lock, token);
  }
};

export const createPodStore = (root: string, options: PodStoreOptions = {}) => {
  const { scopePodId } = options;
  const buildingLock = {
    timeoutMs: options.buildingLock?.timeoutMs ?? BUILDING_LOCK_TIMEOUT_MS,
    staleMs: options.buildingLock?.staleMs ?? BUILDING_LOCK_STALE_MS,
  };

  const podDir = (podId: string): string => {
    assertId(podId, 'pod id');

    if (scopePodId !== undefined && podId !== scopePodId) {
      throw new PodScopeError(
        `This agent belongs to pod "${scopePodId}" and may not touch pod "${podId}".`
      );
    }

    return path.join(root, podId);
  };

  const file = (podId: string, ...parts: string[]): string =>
    path.join(podDir(podId), ...parts);

  const listPodIds = (): string[] => {
    if (!fs.existsSync(root)) {
      return [];
    }

    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          ID_PATTERN.test(entry.name) &&
          fs.existsSync(path.join(root, entry.name, 'pod.json'))
      )
      .map((entry) => entry.name)
      .filter((podId) => scopePodId === undefined || podId === scopePodId);
  };

  const readPod = (podId: string): Pod | null =>
    readJson(file(podId, 'pod.json'), PodSchema);

  const requirePod = (podId: string): Pod => {
    const pod = readPod(podId);

    if (pod === null) {
      throw new Error(`No pod "${podId}" under ${root}`);
    }

    return pod;
  };

  const writePod = (pod: Pod): void =>
    writeJsonAtomic(file(pod.id, 'pod.json'), PodSchema.parse(pod));

  const updatePod = (podId: string, patch: (pod: Pod) => Pod): Pod => {
    const next = patch(requirePod(podId));
    writePod(next);

    return next;
  };

  const listQuestions = (podId: string): Question[] => {
    const dir = file(podId, 'questions');

    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        QuestionSchema.parse(
          JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        )
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const readQuestion = (podId: string, qid: string): Question | null =>
    readJson(
      file(podId, 'questions', `${assertId(qid, 'question id')}.json`),
      QuestionSchema
    );

  const requireQuestion = (podId: string, qid: string): Question => {
    const question = readQuestion(podId, qid);

    if (question === null) {
      throw new Error(`No question "${qid}" in pod "${podId}"`);
    }

    return question;
  };

  const writeQuestion = (question: Question): void =>
    writeJsonAtomic(
      file(
        question.podId,
        'questions',
        `${assertId(question.id, 'question id')}.json`
      ),
      QuestionSchema.parse(question)
    );

  /** An earlier version of a card, kept as it was (see versions.ts). */
  const writeQuestionVersion = (question: Question): void =>
    writeJsonAtomic(
      file(
        question.podId,
        'versions',
        assertId(question.id, 'question id'),
        `${question.checkpoint?.version ?? 1}.json`
      ),
      QuestionSchema.parse(question)
    );

  /** A card's kept versions, oldest first (the current one isn't here). */
  const listQuestionVersions = (podId: string, qid: string): Question[] => {
    const dir = file(podId, 'versions', assertId(qid, 'question id'));

    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs
      .readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) =>
        QuestionSchema.parse(
          JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        )
      )
      .sort(
        (a, b) => (a.checkpoint?.version ?? 1) - (b.checkpoint?.version ?? 1)
      );
  };

  /** q1, q2, … — never reuses a number, withdrawn questions keep their files. */
  const nextQuestionId = (podId: string): string => {
    const numbers = listQuestions(podId)
      .map((question) => Number(/^q(\d+)$/.exec(question.id)?.[1] ?? 0))
      .filter((n) => Number.isFinite(n));

    return `q${Math.max(0, ...numbers) + 1}`;
  };

  const listRequests = (podId: string): WorkRequest[] => {
    const dir = file(podId, 'requests');

    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        RequestSchema.parse(
          JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        )
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const readRequest = (podId: string, rid: string): WorkRequest | null =>
    readJson(
      file(podId, 'requests', `${assertId(rid, 'request id')}.json`),
      RequestSchema
    );

  const writeRequest = (request: WorkRequest): void =>
    writeJsonAtomic(
      file(
        request.podId,
        'requests',
        `${assertId(request.id, 'request id')}.json`
      ),
      RequestSchema.parse(request)
    );

  /** r1, r2, … — never reuses a number. */
  const nextRequestId = (podId: string): string => {
    const numbers = listRequests(podId).map((request) =>
      Number(/^r(\d+)$/.exec(request.id)?.[1] ?? 0)
    );

    return `r${Math.max(0, ...numbers) + 1}`;
  };

  /** A request queued or running: the pod is being reworked. */
  const activeRequest = (podId: string): WorkRequest | undefined =>
    listRequests(podId).find((request) => request.status !== 'done');

  const appendThread = (entry: ThreadEntry): ThreadEntry => {
    const parsed = ThreadEntrySchema.parse(entry);
    appendJsonl(file(entry.podId, 'thread.jsonl'), parsed);

    return parsed;
  };

  const appendDelivery = (podId: string, event: DeliveryEvent): void =>
    appendJsonl(
      file(podId, 'delivery.jsonl'),
      DeliveryEventSchema.parse(event)
    );

  const readThread = (podId: string): ThreadMessage[] => {
    const events = readJsonl(
      file(podId, 'delivery.jsonl'),
      DeliveryEventSchema
    );

    return readJsonl(file(podId, 'thread.jsonl'), ThreadEntrySchema).map(
      (entry) => ({ ...entry, delivery: foldDelivery(entry, events) })
    );
  };

  const appendHumanDecision = (decision: HumanDecision): HumanDecision => {
    const parsed = HumanDecisionSchema.parse(decision);
    appendJsonl(file(decision.podId, 'human-decisions.jsonl'), parsed);

    return parsed;
  };

  const readHumanDecisions = (podId: string): HumanDecision[] =>
    readJsonl(file(podId, 'human-decisions.jsonl'), HumanDecisionSchema);

  const appendAutonomousDecision = (
    decision: AutonomousDecision
  ): AutonomousDecision => {
    const parsed = AutonomousDecisionSchema.parse(decision);
    appendJsonl(file(decision.podId, 'autonomous-decisions.jsonl'), parsed);

    return parsed;
  };

  const readAutonomousDecisions = (podId: string): AutonomousDecision[] =>
    readJsonl(
      file(podId, 'autonomous-decisions.jsonl'),
      AutonomousDecisionSchema
    );

  /**
   * Rewrite one decision in place (same id, so a checkpoint's numbering and
   * the owner's references still hold). The log is otherwise append-only; this
   * rewrites it atomically.
   */
  const updateAutonomousDecision = (
    podId: string,
    decisionId: string,
    patch: (decision: AutonomousDecision) => AutonomousDecision
  ): AutonomousDecision => {
    const target = file(podId, 'autonomous-decisions.jsonl');
    const all = readJsonl(target, AutonomousDecisionSchema);
    const existing = all.find((decision) => decision.id === decisionId);

    if (existing === undefined) {
      throw new Error(`No autonomous decision ${decisionId} in pod ${podId}.`);
    }

    const updated = AutonomousDecisionSchema.parse({
      ...patch(existing),
      id: decisionId,
    });
    const lines = all
      .map((decision) =>
        JSON.stringify(decision.id === decisionId ? updated : decision)
      )
      .join('\n');
    const tmp = `${target}.${process.pid}.${randomBytes(3).toString(
      'hex'
    )}.tmp`;
    fs.writeFileSync(tmp, `${lines}\n`);
    fs.renameSync(tmp, target);

    return updated;
  };

  const inboxFile = path.join(root, '_inbox.json');

  const readInbox = (): Inbox =>
    readJson(inboxFile, InboxSchema) ?? { priority: [] };

  const writeInbox = (inbox: Inbox): void =>
    writeJsonAtomic(inboxFile, InboxSchema.parse(inbox));

  const readFork = (podId: string, qid: string): Fork | null =>
    readJson(
      file(podId, 'forks', `${assertId(qid, 'question id')}.json`),
      ForkSchema
    );

  const writeFork = (fork: Fork): void =>
    writeJsonAtomic(
      file(fork.podId, 'forks', `${assertId(fork.qid, 'question id')}.json`),
      ForkSchema.parse(fork)
    );

  const listForks = (podId: string): Fork[] => {
    const dir = file(podId, 'forks');

    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        ForkSchema.parse(
          JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        )
      );
  };

  // ── building pods ────────────────────────────────────────────────────────
  const readBuilding = (podId: string): BuildingState =>
    readJson(file(podId, 'building.json'), BuildingStateSchema) ?? {
      runs: [],
      upNext: [],
    };

  const writeBuilding = (podId: string, state: BuildingState): void =>
    writeJsonAtomic(
      file(podId, 'building.json'),
      BuildingStateSchema.parse(state)
    );

  const updateBuilding = (
    podId: string,
    patch: (state: BuildingState) => BuildingState
  ): BuildingState =>
    // Several processes patch this file; the lock keeps each one's change.
    withFileLock(file(podId, 'building.json'), buildingLock, () => {
      const next = patch(readBuilding(podId));
      writeBuilding(podId, next);

      return next;
    });

  /** updateBuilding for the runner service, whose event loop must keep running. */
  const updateBuildingAsync = (
    podId: string,
    patch: (state: BuildingState) => BuildingState
  ): Promise<BuildingState> =>
    withFileLockAsync(file(podId, 'building.json'), buildingLock, () => {
      const next = patch(readBuilding(podId));
      writeBuilding(podId, next);

      return next;
    });

  const screenshotDir = (
    podId: string,
    ticketId: string,
    attempt: number
  ): string =>
    file(podId, 'screenshots', assertTicketFolder(ticketId), String(attempt));

  const readScreenshots = (
    podId: string,
    ticketId: string,
    attempt: number
  ): Screenshot[] =>
    readJson(
      path.join(screenshotDir(podId, ticketId, attempt), 'manifest.json'),
      ScreenshotManifestSchema
    ) ?? [];

  const writeScreenshots = (
    podId: string,
    ticketId: string,
    attempt: number,
    shots: Screenshot[]
  ): void =>
    writeJsonAtomic(
      path.join(screenshotDir(podId, ticketId, attempt), 'manifest.json'),
      ScreenshotManifestSchema.parse(shots)
    );

  const readAsk = (podId: string, threadId: string): AskThread | null =>
    readJson(
      file(podId, 'asks', `${assertId(threadId, 'conversation id')}.json`),
      AskThreadSchema
    );

  const writeAsk = (thread: AskThread): void =>
    writeJsonAtomic(
      file(
        thread.podId,
        'asks',
        `${assertId(thread.id, 'conversation id')}.json`
      ),
      AskThreadSchema.parse(thread)
    );

  const listAsks = (podId: string): AskThread[] => {
    const dir = file(podId, 'asks');

    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.json'))
          .flatMap((name) => {
            // One bad file mustn't stop every other conversation's idle close.
            try {
              return [
                AskThreadSchema.parse(
                  JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
                ),
              ];
            } catch (error) {
              console.warn(
                `⚠ Skipped ${path.join(dir, name)}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );

              return [];
            }
          })
      : [];
  };

  const appendStep = (podId: string, event: StepEvent): StepEvent => {
    const parsed = StepEventSchema.parse(event);
    appendJsonl(file(podId, 'steps.jsonl'), parsed);

    return parsed;
  };

  const readSteps = (podId: string): StepEvent[] =>
    readJsonl(file(podId, 'steps.jsonl'), StepEventSchema);

  const readTurn = (podId: string, agent: string): Turn =>
    readJson(
      file(podId, 'turns', `${assertId(agent, 'agent')}.json`),
      TurnSchema
    ) ?? {};

  const patchTurn = (podId: string, agent: string, patch: Turn): Turn => {
    const next = { ...readTurn(podId, agent), ...patch };
    writeJsonAtomic(
      file(podId, 'turns', `${assertId(agent, 'agent')}.json`),
      next
    );

    return next;
  };

  return {
    root,
    scopePodId,
    podDir,
    file,
    listPodIds,
    readPod,
    requirePod,
    writePod,
    updatePod,
    listQuestions,
    readQuestion,
    requireQuestion,
    writeQuestion,
    writeQuestionVersion,
    listQuestionVersions,
    nextQuestionId,
    appendThread,
    appendDelivery,
    readThread,
    appendHumanDecision,
    readHumanDecisions,
    appendAutonomousDecision,
    readAutonomousDecisions,
    updateAutonomousDecision,
    readInbox,
    writeInbox,
    readFork,
    writeFork,
    listForks,
    readTurn,
    patchTurn,
    appendStep,
    readSteps,
    listRequests,
    readRequest,
    writeRequest,
    nextRequestId,
    activeRequest,
    readBuilding,
    writeBuilding,
    updateBuilding,
    updateBuildingAsync,
    screenshotDir,
    readScreenshots,
    writeScreenshots,
    readAsk,
    writeAsk,
    listAsks,
  };
};

export type PodStore = ReturnType<typeof createPodStore>;
