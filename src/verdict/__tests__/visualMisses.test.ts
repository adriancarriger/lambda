import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fakeSource, ticket } from '../../building/__tests__/fakes';
import { ProjectConfigSchema } from '../../config/projectConfig';
import { writePng } from '../../design/__tests__/pngFixture';
import { createTicketSource } from '../../tickets/context';
import { type CommentOptions, type TicketSource } from '../../tickets/source';
import {
  type Compose,
  buildVisualSection,
  postVisualMisses,
  visualMissesMarker,
} from '../visualMisses';
import { type VisualIssue, type VisualVerdict } from '../visualStore';

/**
 * SHIPPED_WITH_MISSES: one comment on the ticket, expected | actual per
 * picture with an issue worse than low, deduped by its marker; a tracker
 * that fails never fails the record.
 */

const T = 'PAWNEE-5';
const AT = '2026-10-23T10:00:00.000Z';
const root = { path: '' };

/** A fake composite: the expected picture, copied. */
const compose: Compose = async ({ expected, out }) => {
  fs.copyFileSync(expected, out);
};

const missed = (
  scenarioId: string,
  severity: VisualIssue['severity'],
  where: string,
  what: string
): VisualIssue => ({
  severity,
  where,
  what,
  scenarioId,
  situation: `Trail map — ${scenarioId}`,
  expected: `.lambda/pulled/${T}/${scenarioId}.png`,
  actual: `.lambda/verdicts/${T}.visual/round-4/${scenarioId}.png`,
});

const verdict = (): VisualVerdict => ({
  ticketId: T,
  result: 'SHIPPED_WITH_MISSES',
  rounds: 4,
  issues: [
    missed(
      'trail-closed',
      'medium',
      'Legend 2',
      'marker is below the legend, not beside it'
    ),
    missed(
      'trail-closed',
      'medium-low',
      'Show the detour',
      '8px lower than the design'
    ),
    missed('trail-closed', 'low', 'Trail name', 'a shade lighter'),
    missed('trail-open', 'medium', 'Distance', 'the miles are not bold'),
  ],
  recordedAt: AT,
});

beforeEach(() => {
  root.path = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-visual-misses-'))
  );
  fs.writeFileSync(
    path.join(root.path, 'lambda.json'),
    JSON.stringify({ name: 'Pawnee Parks app' })
  );
  ['trail-closed', 'trail-open'].forEach((id) => {
    const expected = path.join(root.path, '.lambda', 'pulled', T, `${id}.png`);
    const actual = path.join(
      root.path,
      '.lambda',
      'verdicts',
      `${T}.visual`,
      'round-4',
      `${id}.png`
    );
    [expected, actual].forEach((file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writePng(file, 4, 4);
    });
  });
});

afterEach(() => {
  fs.rmSync(root.path, { recursive: true, force: true });
});

/** A tracker's source whose comments are recorded. */
const tracker = (overrides: Partial<TicketSource> = {}) => {
  const posted: { text: string; options?: CommentOptions }[] = [];
  const source: TicketSource = {
    ...fakeSource([ticket(T, { title: 'Trail map' })]),
    kind: 'linear',
    comment: async (_id, text, options) => {
      posted.splice(posted.length, 0, { text, options });
    },
    comments: async () => posted.map(({ text }) => text),
    ...overrides,
  };

  return { source, posted };
};

describe('buildVisualSection', () => {
  // Each composite is a headless browser: drawn one after another, never all
  // at once on the runner.
  it('draws one composite at a time', async () => {
    const flight = { now: 0, most: 0 };
    const tracked: Compose = async (input) => {
      flight.now += 1;
      flight.most = Math.max(flight.most, flight.now);
      await new Promise((resolve) => setImmediate(resolve));
      await compose(input);
      flight.now -= 1;
    };

    const section = await buildVisualSection(root.path, verdict(), tracked);

    expect(section.composites).toHaveLength(2);
    expect(flight.most).toBe(1);
  });
});

describe('postVisualMisses', () => {
  it('posts one comment: the heading, the rounds, then each picture with its composite and issues', async () => {
    const { source, posted } = tracker();

    await postVisualMisses(verdict(), {
      projectRoot: root.path,
      source,
      compose,
    });

    expect(posted).toHaveLength(1);
    const [first] = posted;

    if (first === undefined) {
      throw new Error('no comment was posted');
    }

    const { text, options } = first;
    expect(text.split('\n').slice(0, 4)).toEqual([
      visualMissesMarker(T, AT),
      '### 🎨 Visual check: shipped with misses',
      '',
      'After 4 rounds, the build still differs from its design here. Each picture is the design (Expected) beside the build (Actual).',
    ]);
    expect(text).toContain(
      [
        '### Trail map — trail-closed',
        '',
        '{{image:0}}',
        '',
        '- **medium** — Legend 2: marker is below the legend, not beside it',
        '- **medium-low** — Show the detour: 8px lower than the design',
      ].join('\n')
    );
    expect(text).toContain('### Trail map — trail-open');
    expect(text).toContain('- **medium** — Distance: the miles are not bold');
    // A low issue is no miss.
    expect(text).not.toContain('a shade lighter');
    expect(options?.images?.map((image) => path.basename(image.path))).toEqual([
      'visual-trail-closed.png',
      'visual-trail-open.png',
    ]);
    expect(
      fs.existsSync(
        path.join(
          root.path,
          '.lambda',
          'verdicts',
          `${T}.visual`,
          'composite-trail-closed.png'
        )
      )
    ).toBe(true);
  });

  it('says "1 round" for a loop of one', async () => {
    const { source, posted } = tracker();

    await postVisualMisses(
      { ...verdict(), rounds: 1 },
      { projectRoot: root.path, source, compose }
    );

    expect(posted[0]?.text).toContain('After 1 round, the build');
  });

  it('posts nothing the second time for the same record', async () => {
    const { source, posted } = tracker();
    const deps = { projectRoot: root.path, source, compose };

    await postVisualMisses(verdict(), deps);
    await postVisualMisses(verdict(), deps);

    expect(posted).toHaveLength(1);
  });

  it('warns and posts anyway when the comments can’t be read', async () => {
    const warnings: string[] = [];
    const { source, posted } = tracker({
      comments: async () => {
        throw new Error('the tracker answered 500');
      },
    });

    await postVisualMisses(verdict(), {
      projectRoot: root.path,
      source,
      compose,
      warn: (line) => {
        warnings.splice(warnings.length, 0, line);
      },
    });

    expect(posted).toHaveLength(1);
    expect(warnings.join('\n')).toContain('the tracker answered 500');
  });

  it('never throws when the comment fails: a warning, nothing more', async () => {
    const warnings: string[] = [];
    const { source } = tracker({
      comment: async () => {
        throw new Error('upload refused');
      },
    });

    await expect(
      postVisualMisses(verdict(), {
        projectRoot: root.path,
        source,
        compose,
        warn: (line) => {
          warnings.splice(warnings.length, 0, line);
        },
      })
    ).resolves.toBeUndefined();
    expect(warnings.join('\n')).toContain('upload refused');
  });

  it('on a markdown project, saves each composite beside the ticket file and links it under ## Comments', async () => {
    fs.writeFileSync(
      path.join(root.path, 'TASKS.md'),
      `- [ ] ${T}: Trail map\n`
    );
    const config = ProjectConfigSchema.parse({ name: 'Pawnee Parks app' });
    const source = createTicketSource({
      root: root.path,
      config: config.tickets,
      tokens: undefined,
      env: {},
      fetch: globalThis.fetch,
      runner: { name: 'Leslie Knope' },
    });
    await source.update(T, { status: 'building' });

    await postVisualMisses(verdict(), {
      projectRoot: root.path,
      source,
      compose,
    });
    await postVisualMisses(verdict(), {
      projectRoot: root.path,
      source,
      compose,
    });

    expect(
      fs.existsSync(
        path.join(root.path, 'tickets', T, 'visual-trail-closed.png')
      )
    ).toBe(true);
    const ticketFile = fs.readFileSync(
      path.join(root.path, 'tickets', `${T}.md`),
      'utf8'
    );
    const comments = ticketFile.slice(ticketFile.indexOf('## Comments'));
    expect(comments).toContain('### 🎨 Visual check: shipped with misses');
    expect(comments).toContain(`(./${T}/visual-trail-closed.png)`);
    // Deduped through the ticket file's own comments.
    expect(comments.split(visualMissesMarker(T, AT))).toHaveLength(2);
  });
});
