import * as fs from 'fs';
import * as path from 'path';

import { writePng } from '../../design/__tests__/pngFixture';
import { type PodStore } from '../../pod-store';
import { servePodFile } from '../../runner/podFiles';
import { type CommentOptions } from '../../tickets/source';
import { type Compose } from '../../verdict/visualMisses';
import {
  type VisualIssue,
  type VisualVerdict,
  writeVisualVerdict,
} from '../../verdict/visualStore';
import { blockTicket } from '../blocked';
import { createBuildingDriver } from '../driver';
import {
  LESLIE,
  buildingPodStore,
  fakeMothership,
  fakeSource,
  ticket,
} from './fakes';

/** `buildingPodStore`'s runner. */
const RUNNER = 'r-leslie-mac';

/**
 * `lambda pod blocked` and the visual check: a BLOCKED record's pictures go
 * with every block of the ticket, `--visual` fills the four parts, and a
 * picture that can't be made never stops the block.
 */

const T = 'PAWNEE-5';

const compose: Compose = async ({ expected, out }) => {
  fs.copyFileSync(expected, out);
};

const missed = (
  scenarioId: string,
  severity: VisualIssue['severity'],
  what: string
): VisualIssue => ({
  severity,
  where: 'Legend 2',
  what,
  scenarioId,
  situation: `Trail closed — ${scenarioId}`,
  expected: `.lambda/pulled/${T}/${scenarioId}.png`,
  actual: `.lambda/verdicts/${T}.visual/round-7/${scenarioId}.png`,
});

const blockedRecord = (): VisualVerdict => ({
  ticketId: T,
  result: 'BLOCKED',
  rounds: 7,
  issues: [
    missed('trail-closed', 'high', '"Detour" marker is missing'),
    missed('trail-open', 'medium-low', 'the legend is 8px lower'),
  ],
  recordedAt: '2026-10-23T11:00:00.000Z',
});

const setUp = (record: VisualVerdict | null = blockedRecord()) => {
  const { store, root, podId } = buildingPodStore();
  fs.writeFileSync(
    path.join(root, 'lambda.json'),
    JSON.stringify({ name: 'Pawnee Parks app' })
  );
  store.writeBuilding(podId, {
    runs: [
      {
        id: T,
        title: 'Trail map',
        step: 'visual-check',
        attempt: 7,
        startedAt: '2026-10-23T09:00:00.000Z',
        claim: 'claimed',
      },
    ],
    upNext: [],
  });
  ['trail-closed', 'trail-open'].forEach((id) => {
    [
      path.join(root, '.lambda', 'pulled', T, `${id}.png`),
      path.join(
        root,
        '.lambda',
        'verdicts',
        `${T}.visual`,
        'round-7',
        `${id}.png`
      ),
    ].forEach((file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writePng(file, 6, 4);
    });
  });

  if (record !== null) {
    writeVisualVerdict(root, record);
  }

  const posted: { text: string; options?: CommentOptions }[] = [];
  const source = {
    ...fakeSource([ticket(T, { title: 'Trail map', status: 'building' })]),
    comment: async (_id: string, text: string, options?: CommentOptions) => {
      posted.splice(posted.length, 0, { text, options });
    },
  };

  return { store, root, podId, source, posted };
};

const lastItem = (store: PodStore, podId: string) =>
  store.readThread(podId).at(-1);

describe('lambda pod blocked with a BLOCKED visual record', () => {
  it('--visual fills the four parts from the record', async () => {
    const { store, podId, source } = setUp();

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source,
      visual: true,
      compose,
    });

    expect(store.readBuilding(podId).runs[0]?.blocked).toMatchObject({
      what: 'Trail map',
      problem:
        'After 7 rounds the finished screen still differs from the design: Trail closed — trail-closed: "Detour" marker is missing',
      options:
        'compare the pictures and set it back to Ready to retry · change the design in a planning pod',
      recommendation:
        'Compare the pictures. This Lambda moved on to the next ticket.',
    });
    expect(source.statusOf(T)).toBe('blocked');
  });

  it('attaches every picture worse than low: in the pod, on the inbox item and in one ticket comment', async () => {
    const { store, podId, source, posted } = setUp();

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source,
      visual: true,
      compose,
    });

    const item = lastItem(store, podId);
    expect(item?.pictures).toEqual([
      'composite-trail-closed.png',
      'composite-trail-open.png',
    ]);
    expect(item?.picturesAt).toEqual({ ticketId: T, round: 7 });
    (item?.pictures ?? []).forEach((file) => {
      expect(fs.existsSync(store.file(podId, 'visual', T, '7', file))).toBe(
        true
      );
      expect(
        servePodFile(store.root, {
          podId,
          folder: 'visual',
          path: `${T}/7/${file}`,
        })?.headers['content-type']
      ).toBe('image/png');
    });

    expect(posted).toHaveLength(1);
    const [first] = posted;

    if (first === undefined) {
      throw new Error('no comment was posted');
    }

    const { text, options } = first;
    expect(text).toContain(
      '### 🎨 Visual check: a high issue is left after 7 rounds'
    );
    expect(text.split('\n')[0]).toMatch(/^After 7 rounds the finished screen/);
    expect(text).toContain('### Trail closed — trail-closed');
    expect(text).toContain('### Trail closed — trail-open');
    expect(options?.images).toHaveLength(2);
    expect(lastItem(store, podId)?.text).not.toContain("couldn't be attached");
  });

  it('plain lambda pod blocked still carries the pictures, with the parts as passed', async () => {
    const { store, podId, source, posted } = setUp();

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {
        what: 'Trail map',
        problem: 'The design loop ran out',
        options: '1) Retry 2) Redesign',
        recommendation: '1',
      },
      source,
      compose,
    });

    expect(lastItem(store, podId)?.pictures).toHaveLength(2);
    expect(store.readBuilding(podId).runs[0]?.blocked?.problem).toBe(
      'The design loop ran out'
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text.split('\n')[0]).toBe('The design loop ran out');
  });

  it('a composite that fails: still blocked, the comment says why, and so does the inbox item', async () => {
    const { store, podId, source, posted } = setUp();

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source,
      visual: true,
      compose: async () => {
        throw new Error('Chromium could not start');
      },
    });

    expect(source.statusOf(T)).toBe('blocked');
    expect(posted[0]?.text).toMatch(
      /_visual section could not be attached: Chromium could not start_$/
    );
    expect(posted[0]?.options).toBeUndefined();
    const item = lastItem(store, podId);
    expect(item?.text).toContain(
      "The pictures couldn't be attached: Chromium could not start."
    );
    expect(item?.pictures).toBeUndefined();
  });

  it('a reason that ends its own sentence gets one full stop in the inbox item', async () => {
    const { store, podId, source } = setUp();

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source,
      visual: true,
      compose: async () => {
        throw new Error("x.png isn't a PNG, so its size can't be read.");
      },
    });

    const text = lastItem(store, podId)?.text ?? '';
    expect(text).toContain(
      "The pictures couldn't be attached: x.png isn't a PNG, so its size can't be read."
    );
    expect(text).not.toContain('..');
  });

  it('a picture the tracker refuses: the comment goes again without them, saying why, and so does the inbox item', async () => {
    const { store, podId, source, posted } = setUp();

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source: {
        ...source,
        // Attaching happens inside the comment: a refused upload fails it whole.
        comment: async (id, text, options) => {
          if ((options?.images ?? []).length > 0) {
            throw new Error('the upload was refused (413)');
          }

          return source.comment(id, text, options);
        },
      },
      visual: true,
      compose,
    });

    expect(source.statusOf(T)).toBe('blocked');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.options).toBeUndefined();
    expect(posted[0]?.text).toContain(
      '### 🎨 Visual check: a high issue is left after 7 rounds'
    );
    expect(posted[0]?.text).toMatch(
      /_visual section could not be attached: the upload was refused \(413\)_$/
    );
    expect(lastItem(store, podId)?.text).toContain(
      "The pictures couldn't be attached: the upload was refused (413)."
    );
  });

  it('releases its claim: the runner lets the blocked ticket go on its next tick', async () => {
    const { store, root, podId, source } = setUp();
    const mothership = fakeMothership();
    mothership.rows.set(T, {
      ticketId: T,
      runnerId: RUNNER,
      shippedAt: null,
    });

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source,
      visual: true,
      compose,
    });
    await createBuildingDriver({
      store,
      podId,
      projectRoot: root,
      runnerId: RUNNER,
      source: () => source,
      owner: () => LESLIE,
      mothership: mothership.forRunner(RUNNER),
      interrupt: async () => undefined,
      send: async () => undefined,
      block: async () => undefined,
      panes: () => '',
      now: () => Date.parse('2026-10-23T12:00:00.000Z'),
      log: () => undefined,
    }).tick();

    expect(mothership.rows.has(T)).toBe(false);
    expect(store.readBuilding(podId).runs[0]).toMatchObject({
      id: T,
      claim: 'released',
      blocked: expect.objectContaining({ what: 'Trail map' }),
    });
  });

  it('a comment that fails is logged, and the ticket is still blocked', async () => {
    const { store, podId, source } = setUp();
    const logged: string[] = [];

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source: {
        ...source,
        comment: async () => {
          throw new Error('the tracker answered 500');
        },
      },
      visual: true,
      compose,
      log: (line) => {
        logged.splice(logged.length, 0, line);
      },
    });

    expect(source.statusOf(T)).toBe('blocked');
    expect(logged.join('\n')).toContain('the tracker answered 500');
  });
});

describe('lambda pod blocked without a BLOCKED visual record', () => {
  it('plain: no comment and no pictures, exactly as before', async () => {
    const { store, podId, source, posted } = setUp(null);

    await blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {
        what: 'Trail map',
        problem: 'Stuck',
        options: '1) Retry',
        recommendation: '1',
      },
      source,
      compose,
    });

    expect(posted).toEqual([]);
    expect(lastItem(store, podId)?.pictures).toBeUndefined();
    expect(source.statusOf(T)).toBe('blocked');
  });

  it.each([
    ['no record', null],
    [
      'a MATCH record',
      { ...blockedRecord(), result: 'MATCH' as const, issues: [] },
    ],
  ])('--visual with %s is refused, writing nothing', async (_, record) => {
    const { store, podId, source, posted } = setUp(record);

    await expect(
      blockTicket({
        store,
        podId,
        ticketId: T,
        parts: {},
        source,
        visual: true,
        compose,
      })
    ).rejects.toThrow(`${T} has no blocked visual check.`);
    expect(posted).toEqual([]);
    expect(source.updates).toEqual([]);
    expect(store.readThread(podId)).toEqual([]);
    expect(store.readBuilding(podId).runs[0]?.blocked).toBeUndefined();
  });

  it('--visual with an unreadable record is refused, naming why', async () => {
    const { store, root, podId, source } = setUp(null);
    fs.mkdirSync(path.join(root, '.lambda', 'verdicts'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.lambda', 'verdicts', `${T}.visual.json`),
      '{ not json'
    );

    const refusal = blockTicket({
      store,
      podId,
      ticketId: T,
      parts: {},
      source,
      visual: true,
      compose,
    });

    await expect(refusal).rejects.toThrow(
      `${T} has no blocked visual check: its record couldn't be read (`
    );
    expect(store.readThread(podId)).toEqual([]);
  });
});
