import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { NO_PROJECT, recordEvent } from '../../commands/event';
import { tempHome } from '../../mothership/__tests__/harness';
import { createPodStore } from '../../pod-store';
import type { ForwardedEvent } from '../schema';
import {
  EVENTS_FILE,
  MAX_READ_BYTES,
  type WatchSource,
  eventId,
  eventMessage,
  readNewLines,
  scanOnce,
  stepToEvent,
  toForwarded,
} from '../watcher';

const AT = '2026-10-21T12:00:00.000Z';

describe('lambda event and events.jsonl', () => {
  const fixture: { root?: string; home?: string } = {};
  const root = (): string => required(fixture.root, 'root');
  const home = (): string => required(fixture.home, 'home');

  beforeEach(() => {
    fixture.root = tempHome();
    fixture.home = tempHome();
    fs.writeFileSync(
      path.join(root(), 'lambda.json'),
      '{"name":"Pawnee Parks site"}'
    );
  });

  afterEach(() => {
    fs.rmSync(root(), { recursive: true, force: true });
    fs.rmSync(home(), { recursive: true, force: true });
  });

  const scanned: {
    sent: { id: string; event: ForwardedEvent; generation: number }[];
  } = {
    sent: [],
  };
  const scan = (sources: WatchSource[]) =>
    scanOnce({
      runnerId: 'rnr_3f9a',
      sources,
      cursorFile: path.join(home(), 'events-cursor.json'),
      store: null,
      send: (id, event, generation) => {
        scanned.sent = [...scanned.sent, { id, event, generation }];
      },
      now: () => AT,
    });

  beforeEach(() => {
    scanned.sent = [];
  });

  it('the command and a hand-written line are the same event', () => {
    const file = recordEvent(
      path.join(root()),
      'metric',
      { name: 'bundle', value: '412', unit: 'KB' },
      {},
      () => AT
    );
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        type: 'metric',
        name: 'bundle',
        value: 412,
        unit: 'KB',
        at: AT,
      })}\n`
    );

    scan([{ file, kind: 'events' }]);

    expect(file).toBe(path.join(root(), EVENTS_FILE));
    expect(scanned.sent.map(({ event }) => event)).toEqual([
      expect.objectContaining({
        type: 'metric',
        name: 'bundle',
        value: 412,
        unit: 'KB',
        at: AT,
      }),
      expect.objectContaining({
        type: 'metric',
        name: 'bundle',
        value: 412,
        unit: 'KB',
        at: AT,
      }),
    ]);
    expect(scanned.sent[0]?.event).toEqual(scanned.sent[1]?.event);
  });

  it('writes in the nearest folder with lambda.json going up', () => {
    const worktree = path.join(root(), 'pods', 'dog-park');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'lambda.json'), '{}');

    expect(
      recordEvent(
        path.join(worktree, 'src'),
        'metric',
        { name: 'x' },
        {},
        () => AT
      )
    ).toBe(path.join(worktree, EVENTS_FILE));
  });

  it('refuses outside any project', () => {
    expect(() => recordEvent(home(), 'metric', { name: 'x' }, {})).toThrow(
      NO_PROJECT
    );
  });

  it('gives a line read again after a cursor rollback the same id, and a restart sends nothing twice', () => {
    const file = recordEvent(
      root(),
      'metric',
      { name: 'bundle' },
      {},
      () => AT
    );
    scan([{ file, kind: 'events' }]);
    const first = scanned.sent[0]?.id;

    scan([{ file, kind: 'events' }]);

    expect(scanned.sent).toHaveLength(1);

    fs.rmSync(path.join(home(), 'events-cursor.json'));
    scan([{ file, kind: 'events' }]);

    expect(scanned.sent).toHaveLength(2);
    expect(scanned.sent[1]?.id).toBe(first);
    expect(first).toBe(eventId('rnr_3f9a', file, 0));
    expect(first).toMatch(/^rnr_3f9a:[0-9a-f]{12}:0$/);
  });

  it('turns a bad line into a warning, never dropping it', () => {
    expect(toForwarded('not json', { now: () => AT })).toMatchObject({
      type: 'invalid',
      warning: "A line in events.jsonl that isn't an event.",
      raw: 'not json',
    });
  });

  it('reads only complete lines, and starts over on a file that shrank', () => {
    const file = path.join(root(), 'x.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":');

    expect(readNewLines(file, 0)).toEqual({
      lines: [{ offset: 0, text: '{"a":1}' }],
      next: 8,
    });
    expect(readNewLines(file, 8)).toEqual({ lines: [], next: 8 });

    fs.writeFileSync(file, '{"c":3}\n');

    expect(readNewLines(file, 20).lines).toEqual([
      { offset: 0, text: '{"c":3}' },
    ]);
  });

  it('reads a big backlog a few MB at a time, and still gets through it', () => {
    const file = path.join(root(), 'big.jsonl');
    const line = `{"type":"metric","name":"bundle","value":${'1'.repeat(
      80
    )}}\n`;
    const count = Math.ceil((10 * 1024 * 1024) / line.length);
    fs.writeFileSync(file, line.repeat(count));

    const first = readNewLines(file, 0);
    const passes = [first];

    while ((passes.at(-1)?.next ?? 0) < fs.statSync(file).size) {
      passes.splice(
        passes.length,
        0,
        readNewLines(file, passes.at(-1)?.next ?? 0)
      );
    }

    // Absolute numbers, not MAX_READ_BYTES itself: an unbounded cap (say
    // Infinity) must fail here, not pass vacuously.
    expect(MAX_READ_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(first.next).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(first.next).toBeLessThan(fs.statSync(file).size);
    expect(passes.length).toBeGreaterThan(1);
    expect(passes.reduce((total, pass) => total + pass.lines.length, 0)).toBe(
      count
    );
  });

  it('gets past one line longer than a read, instead of stalling on it', () => {
    const file = path.join(root(), 'huge.jsonl');
    fs.writeFileSync(file, `${'x'.repeat(MAX_READ_BYTES + 10)}\n{"a":1}\n`);

    const first = readNewLines(file, 0);
    const second = readNewLines(file, first.next);

    expect(first.next).toBeGreaterThan(0);
    expect(
      [...first.lines, ...second.lines].map((read) => read.text)
    ).toContain('{"a":1}');
  });

  it('writes the pod’s ticket and attempt into the line, as they are when it’s written', () => {
    const store = createPodStore(path.join(root(), '.lambda', 'pods'));
    store.writePod({
      id: 'dog-park',
      slug: 'dog-park',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: AT,
      worktreePath: root(),
      ownsWorktree: false,
      managerCwd: root(),
      devCwd: root(),
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    store.appendStep('dog-park', {
      at: AT,
      step: 'security-review',
      event: 'start',
      ticket: 'PAWNEE-12',
      pass: 2,
    });
    const file = recordEvent(
      root(),
      'stage.start',
      { name: 'build' },
      { POD_ID: 'dog-park' },
      () => AT
    );
    // The pod moves on before the runner reads the line.
    store.appendStep('dog-park', {
      at: AT,
      step: 'security-review',
      event: 'start',
      ticket: 'PAWNEE-13',
      pass: 1,
    });

    expect(JSON.parse(fs.readFileSync(file, 'utf8').trim())).toMatchObject({
      pod: 'dog-park',
      ticket: 'PAWNEE-12',
      attempt: 2,
    });
  });

  it('reads a pod’s steps once a scan, not once a line', () => {
    const store = createPodStore(path.join(root(), '.lambda', 'pods'));
    const reads = { steps: 0 };
    const counting = {
      ...store,
      readSteps: (podId: string) => {
        reads.steps += 1;

        return store.readSteps(podId);
      },
    };
    const file = path.join(root(), 'events.jsonl');
    fs.writeFileSync(
      file,
      '{"type":"metric","name":"bundle","value":1}\n'.repeat(50)
    );

    scanOnce({
      runnerId: 'rnr_3f9a',
      sources: [{ file, kind: 'events', pod: 'dog-park' }],
      cursorFile: path.join(home(), 'events-cursor.json'),
      store: counting,
      send: () => undefined,
      now: () => AT,
    });

    expect(reads.steps).toBe(1);
  });

  it("tags a line in a pod's worktree with that pod and its current ticket run", () => {
    const store = createPodStore(path.join(root(), '.lambda', 'pods'));
    store.writePod({
      id: 'dog-park',
      slug: 'dog-park',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: AT,
      worktreePath: root(),
      ownsWorktree: false,
      managerCwd: root(),
      devCwd: root(),
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    store.appendStep('dog-park', {
      at: AT,
      step: 'security-review',
      event: 'start',
      ticket: 'PAWNEE-12',
      pass: 2,
    });
    const file = recordEvent(
      root(),
      'stage.end',
      { name: 'security-review' },
      { POD_ID: 'dog-park' },
      () => AT
    );
    const explicit = recordEvent(
      root(),
      'stage.end',
      { name: 'security-review', ticket: 'PAWNEE-9', attempt: '1' },
      {},
      () => AT
    );

    scanOnce({
      runnerId: 'rnr_3f9a',
      sources: [{ file, kind: 'events', pod: 'dog-park' }],
      cursorFile: path.join(home(), 'events-cursor.json'),
      store,
      send: (id, event, generation) => {
        scanned.sent = [...scanned.sent, { id, event, generation }];
      },
      now: () => AT,
    });

    expect(explicit).toBe(file);
    expect(scanned.sent.map(({ event }) => event)).toEqual([
      expect.objectContaining({
        pod: 'dog-park',
        ticket: 'PAWNEE-12',
        attempt: 2,
      }),
      expect.objectContaining({ pod: 'dog-park', ticket: 'PAWNEE-9', attempt: 1 }),
    ]);
  });

  it("turns a pod's steps.jsonl start and done lines into Lambda's stage events", () => {
    expect(
      stepToEvent({ at: AT, step: 'ux-sketch', event: 'start' }, 'dog-park')
    ).toEqual({
      type: 'stage.start',
      name: 'ux-sketch',
      at: AT,
      pod: 'dog-park',
      source: 'lambda',
    });
    expect(
      stepToEvent({ at: AT, step: 'ux-sketch', event: 'done' }, 'dog-park')
        ?.type
    ).toBe('stage.end');
    expect(
      stepToEvent({ at: AT, step: 'ux-sketch', event: 'skip' }, 'dog-park')
    ).toBeNull();
  });

  describe('review fixes', () => {
    const podStore = () => {
      const store = createPodStore(path.join(root(), '.lambda', 'pods'));
      store.writePod({
        id: 'dog-park',
        slug: 'dog-park',
        status: 'active',
        phase: 1,
        completedCheckpoints: [],
        createdAt: AT,
        worktreePath: root(),
        ownsWorktree: false,
        managerCwd: root(),
        devCwd: root(),
        agentCommand: 'claude',
        sessions: { manager: 'm', dev: 'd' },
      });
      store.appendStep('dog-park', {
        at: AT,
        step: 'security-review',
        event: 'start',
        ticket: 'PAWNEE-12',
        pass: 2,
      });

      return store;
    };
    const scanWith = (
      sources: WatchSource[],
      store: ReturnType<typeof createPodStore> | null = null
    ) =>
      scanOnce({
        runnerId: 'rnr_3f9a',
        sources,
        cursorFile: path.join(home(), 'events-cursor.json'),
        store,
        send: (id, event, generation) => {
          scanned.sent = [...scanned.sent, { id, event, generation }];
        },
        now: () => AT,
      });

    it("tags a POD_ID line with that pod's ticket run when the file has no pod of its own", () => {
      const store = podStore();
      const file = recordEvent(
        root(),
        'stage.end',
        { name: 'security-review' },
        { POD_ID: 'dog-park' },
        () => AT
      );

      scanWith([{ file, kind: 'events' }], store);

      expect(scanned.sent.map(({ event }) => event)).toEqual([
        expect.objectContaining({
          pod: 'dog-park',
          ticket: 'PAWNEE-12',
          attempt: 2,
        }),
      ]);
    });

    it('reads a file listed twice once, as the pod it belongs to', () => {
      const store = podStore();
      const file = recordEvent(
        root(),
        'stage.end',
        { name: 'security-review' },
        {},
        () => AT
      );

      scanWith(
        [
          { file, kind: 'events' },
          { file, kind: 'events', pod: 'dog-park' },
        ],
        store
      );

      expect(scanned.sent.map(({ event }) => event)).toEqual([
        expect.objectContaining({
          pod: 'dog-park',
          ticket: 'PAWNEE-12',
          attempt: 2,
        }),
      ]);
    });

    it("doesn't borrow the run's attempt for another ticket", () => {
      const store = podStore();
      const file = recordEvent(
        root(),
        'attempt.end',
        { ticket: 'PAWNEE-9', result: 'fail' },
        { POD_ID: 'dog-park' },
        () => AT
      );

      scanWith([{ file, kind: 'events', pod: 'dog-park' }], store);

      expect(scanned.sent[0]?.event).toMatchObject({ ticket: 'PAWNEE-9' });
      expect(scanned.sent[0]?.event.attempt).toBeUndefined();
    });

    it("keeps the spec's id after a rewrite, sending the rewrite as a new generation", () => {
      const file = recordEvent(root(), 'metric', { name: 'a' }, {}, () => AT);
      const { size } = fs.statSync(file);
      recordEvent(root(), 'metric', { name: 'b' }, {}, () => AT);
      scanWith([{ file, kind: 'events' }]);
      fs.writeFileSync(file, '');
      recordEvent(root(), 'metric', { name: 'c' }, {}, () => AT);
      scanWith([{ file, kind: 'events' }]);

      expect(
        scanned.sent.map(({ event, id, generation }) => [
          event.name,
          id,
          generation,
        ])
      ).toEqual([
        ['a', eventId('rnr_3f9a', file, 0), 0],
        ['b', eventId('rnr_3f9a', file, size), 0],
        ['c', eventId('rnr_3f9a', file, 0), 1],
      ]);
    });

    it('reads a replaced file (a new inode) from the top, as a new generation', () => {
      const file = recordEvent(root(), 'metric', { name: 'a' }, {}, () => AT);
      scanWith([{ file, kind: 'events' }]);
      fs.renameSync(file, `${file}.old`);
      recordEvent(root(), 'metric', { name: 'b' }, {}, () => AT);
      recordEvent(root(), 'metric', { name: 'c' }, {}, () => AT);
      scanWith([{ file, kind: 'events' }]);

      expect(
        scanned.sent.map(({ event, generation }) => [event.name, generation])
      ).toEqual([
        ['a', 0],
        ['b', 1],
        ['c', 1],
      ]);
      expect(scanned.sent[1]?.id).toBe(eventId('rnr_3f9a', file, 0));
    });

    it("sends a rewrite's event under its own delivery id, the event's id unchanged", () => {
      const id = eventId('rnr_3f9a', path.join(root(), EVENTS_FILE), 0);

      expect(eventMessage(id, 0)).toEqual({ id });
      expect(eventMessage(id, 2)).toEqual({
        id: `${id}#2`,
        eventId: id,
        generation: 2,
      });
    });

    it('keeps reading a cursor written in the old format', () => {
      const file = recordEvent(root(), 'metric', { name: 'a' }, {}, () => AT);
      const { size } = fs.statSync(file);
      fs.writeFileSync(
        path.join(home(), 'events-cursor.json'),
        JSON.stringify({ [path.resolve(file)]: size })
      );
      recordEvent(root(), 'metric', { name: 'b' }, {}, () => AT);
      scanWith([{ file, kind: 'events' }]);

      expect(scanned.sent.map(({ event }) => event.name)).toEqual(['b']);
      expect(scanned.sent[0]?.id).toBe(eventId('rnr_3f9a', file, size));
    });

    it('leaves the cursor file alone on a scan where nothing moved', () => {
      const file = recordEvent(root(), 'metric', { name: 'a' }, {}, () => AT);
      const cursorFile = path.join(home(), 'events-cursor.json');
      scanWith([{ file, kind: 'events' }]);
      const written = fs.statSync(cursorFile).ino;

      scanWith([{ file, kind: 'events' }]);

      // Every write is a new file renamed into place: a new inode.
      expect(fs.statSync(cursorFile).ino).toBe(written);
    });

    it('forgets the place in a file whose folder is gone (a deleted pod)', () => {
      const podDir = path.join(root(), 'pods', 'dog-park');
      fs.mkdirSync(podDir, { recursive: true });
      const steps = path.join(podDir, 'steps.jsonl');
      fs.writeFileSync(
        steps,
        `${JSON.stringify({ at: AT, step: 'ux-sketch', event: 'start' })}\n`
      );
      const kept = recordEvent(root(), 'metric', { name: 'a' }, {}, () => AT);
      scanWith([
        { file: kept, kind: 'events' },
        { file: steps, kind: 'steps', pod: 'dog-park' },
      ]);
      fs.rmSync(podDir, { recursive: true, force: true });

      scanWith([{ file: kept, kind: 'events' }]);

      expect(
        Object.keys(
          JSON.parse(
            fs.readFileSync(path.join(home(), 'events-cursor.json'), 'utf8')
          )
        )
      ).toEqual([path.resolve(kept)]);
    });

    it("skips a settled pod's steps.jsonl once it has been read to its end", () => {
      const file = path.join(root(), 'steps.jsonl');
      const step = (name: string) =>
        fs.appendFileSync(
          file,
          `${JSON.stringify({ at: AT, step: name, event: 'start' })}\n`
        );
      step('ux-sketch');
      scanWith([{ file, kind: 'steps', pod: 'dog-park', settled: true }]);
      step('red-flags');

      // Done: never opened again, whatever is in it.
      scanWith([{ file, kind: 'steps', pod: 'dog-park', settled: true }]);
      const whileDone = scanned.sent.map(({ event }) => event.name);
      // Active again: read on from where it was.
      scanWith([{ file, kind: 'steps', pod: 'dog-park' }]);

      expect(whileDone).toEqual(['ux-sketch']);
      expect(scanned.sent.map(({ event }) => event.name)).toEqual([
        'ux-sketch',
        'red-flags',
      ]);
    });

    it('refuses a cursor file that is not JSON instead of starting over', () => {
      const file = recordEvent(root(), 'metric', { name: 'a' }, {}, () => AT);
      fs.writeFileSync(path.join(home(), 'events-cursor.json'), '{oops');

      expect(() => scanWith([{ file, kind: 'events' }])).toThrow(
        /events-cursor\.json/
      );
    });

    it('turns a bad steps.jsonl line into a warning event, never skipping it', () => {
      const file = path.join(root(), 'steps.jsonl');
      fs.writeFileSync(
        file,
        `not json\n${JSON.stringify({ step: 'ux-sketch', event: 'start' })}\n`
      );

      scanWith([{ file, kind: 'steps', pod: 'dog-park' }]);

      expect(scanned.sent.map(({ event }) => event)).toEqual([
        expect.objectContaining({
          type: 'invalid',
          pod: 'dog-park',
          source: 'lambda',
          raw: 'not json',
        }),
        expect.objectContaining({
          type: 'invalid',
          pod: 'dog-park',
          source: 'lambda',
        }),
      ]);
      expect(scanned.sent[1]?.event.warning).toEqual(expect.any(String));
    });
  });
});
