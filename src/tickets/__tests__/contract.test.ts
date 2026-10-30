/**
 * One contract, three trackers: the same steps against plain files in a temp
 * folder, a fake Linear and a fake Jira, with identical results. No network:
 * Linear and Jira run on in-memory fakes behind `fetch`.
 *
 * Why fakes and not recorded responses: a recording has to be made against a
 * live tracker, and a test can't count on one. A real workspace has no test
 * team to write into, so `create`/`delete` would write real issues. A recording is also one fixed request sequence: the contract
 * creates, then reads back what it created, so every id and order in a reply
 * depends on the writes before it — a stateful fake answers that, a replay
 * can't. The exact requests each tracker receives are pinned instead by the
 * per-source suites (`linear.test.ts`, `jira.test.ts`), which assert the
 * GraphQL operations and REST calls one by one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type SourceContext, createTicketSource } from '../context';
import { type Ticket, type TicketSource } from '../source';
import {
  JIRA_FAKE_PROJECT,
  JIRA_FAKE_SITE,
  JIRA_FAKE_STATUSES,
  createJiraFake,
} from './fakes/jiraFake';
import {
  PAWNEE_STATES,
  PAWNEE_STATUSES,
  createLinearFake,
} from './fakes/linearFake';

const leslie = { name: 'Leslie Knope', email: 'leslie@pawnee.gov' };

const noFetch: typeof fetch = async () => {
  throw new Error('No network call expected.');
};

const base = (overrides: Partial<SourceContext>): SourceContext => ({
  root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'))),
  config: { source: 'markdown', prefix: 'PAWNEE' },
  tokens: undefined,
  env: {},
  fetch: noFetch,
  runner: leslie,
  ...overrides,
});

interface Opened {
  source: TicketSource;
  root: string;
}

const opened = (context: SourceContext): Opened => ({
  source: createTicketSource(context),
  root: context.root,
});

const SOURCES: Array<[string, () => Opened]> = [
  [
    'markdown',
    () => {
      const context = base({});
      fs.writeFileSync(path.join(context.root, 'TASKS.md'), '# Tasks\n\n');

      return opened(context);
    },
  ],
  [
    'linear',
    () =>
      opened(
        base({
          config: {
            source: 'linear',
            statuses: { ...PAWNEE_STATUSES, inbox: 'Inbox' },
            team: 'PAWNEE',
            prefix: 'PAWNEE',
          },
          tokens: { linear: 'lin_api_test' },
          fetch: createLinearFake({
            viewer: leslie,
            states: [
              { id: 'st-inbox', name: 'Inbox', type: 'backlog' },
              ...PAWNEE_STATES,
            ],
          }).fetch,
        })
      ),
  ],
  [
    'jira',
    () =>
      opened(
        base({
          config: {
            source: 'jira',
            statuses: { ...JIRA_FAKE_STATUSES, inbox: 'Inbox' },
            site: JIRA_FAKE_SITE,
            project: JIRA_FAKE_PROJECT,
            prefix: 'PAWNEE',
          },
          tokens: { jira: { email: leslie.email, apiToken: 'jira-test' } },
          fetch: createJiraFake({
            statuses: [...Object.values(JIRA_FAKE_STATUSES), 'Inbox'],
          }).fetch,
        })
      ),
  ],
];

/** What the contract compares: titles, not ids (each tracker numbers its own). */
const transcript = async ({ source, root }: Opened): Promise<unknown[]> => {
  const steps: unknown[] = [];
  const note = (step: unknown): void => {
    steps.splice(steps.length, 0, step);
  };
  const titleOf = (tickets: Ticket[], id: string | null): string | null =>
    id === null
      ? null
      : tickets.find((ticket) => ticket.id === id)?.title ?? id;
  const nextTitle = async (): Promise<string | null> =>
    (await source.next())?.title ?? null;

  const epic = await source.create({ title: 'Park map page', status: 'ready' });
  const tiles = await source.create({
    title: 'Map tiles',
    parent: epic.id,
    status: 'ready',
  });
  const pins = await source.create({
    title: 'Pins for each park',
    parent: epic.id,
    status: 'ready',
  });
  const signUp = await source.create({
    title: 'Volunteer sign-up form',
    status: 'ready',
    description: 'Ann Perkins runs the volunteers.',
  });
  const pit = await source.create({ title: 'Lot 48 pit photo gallery' });

  const all = await source.list();
  note(
    all.map((ticket) => [
      ticket.title,
      ticket.status,
      titleOf(all, ticket.parent),
      ticket.children.map((child) => titleOf(all, child)),
    ])
  );

  const got = await source.get(signUp.id);
  note([got.title, got.status, got.description.trim(), got.reporter?.name]);

  note(['next', await nextTitle()]);

  await source.update(tiles.id, { status: 'done' });
  note(['next after tiles', await nextTitle()]);

  await source.update(pins.id, {
    status: 'blocked',
    reason: 'Ann Perkins is out',
  });
  note(['next with pins blocked', await nextTitle()]);

  await source.block(signUp.id, pit.id);
  note([
    'blocked by the pit',
    (await source.get(signUp.id)).blockedBy.map((id) => titleOf(all, id)),
    await nextTitle(),
  ]);

  await source.comment(signUp.id, 'Ben Wyatt: the form is next.');
  // Read back through pull: the ticket file (markdown) or comments.md.
  const pulled = path.resolve(root, await source.pull(signUp.id));
  const comments = fs.statSync(pulled).isDirectory()
    ? path.join(pulled, 'comments.md')
    : pulled;
  note([
    'commented',
    fs.readFileSync(comments, 'utf8').includes('Ben Wyatt: the form is next.'),
  ]);

  await expect(source.place([pit.id, pit.id], signUp.id)).rejects.toThrow(
    `Can't place a ticket twice: ${pit.id} is repeated.`
  );

  await source.reorder(epic.id, [pins.id, tiles.id]);
  note([
    'reordered',
    (await source.get(epic.id)).children.map((id) => titleOf(all, id)),
  ]);

  await expect(source.reorder(epic.id, [pins.id])).rejects.toThrow(
    `missing ${tiles.id}`
  );
  await expect(source.delete(epic.id, 'Not needed')).rejects.toThrow(
    `${epic.id} still has children:`
  );

  await source.delete(pit.id, 'Ann filled in the pit');
  await expect(source.get(pit.id)).rejects.toThrow(
    `${pit.id} isn't a ticket I can read.`
  );
  note(['after delete', (await source.list()).map((ticket) => ticket.title)]);

  return steps;
};

const EXPECTED = [
  [
    ['Park map page', 'ready', null, ['Map tiles', 'Pins for each park']],
    ['Map tiles', 'ready', 'Park map page', []],
    ['Pins for each park', 'ready', 'Park map page', []],
    ['Volunteer sign-up form', 'ready', null, []],
    ['Lot 48 pit photo gallery', 'inbox', null, []],
  ],
  [
    'Volunteer sign-up form',
    'ready',
    'Ann Perkins runs the volunteers.',
    'Leslie Knope',
  ],
  ['next', 'Map tiles'],
  ['next after tiles', 'Pins for each park'],
  ['next with pins blocked', 'Volunteer sign-up form'],
  ['blocked by the pit', ['Lot 48 pit photo gallery'], null],
  ['commented', true],
  ['reordered', ['Pins for each park', 'Map tiles']],
  [
    'after delete',
    [
      'Park map page',
      'Pins for each park',
      'Map tiles',
      'Volunteer sign-up form',
    ],
  ],
];

describe('the ticket contract', () => {
  it.each(SOURCES)('%s gives the same results', async (_name, open) => {
    expect(await transcript(open())).toEqual(EXPECTED);
  });
});

// ── files and pictures ──────────────────────────────────────────────────────

/** One source holding PAWNEE-5, and what it was sent. */
interface Pictured {
  source: TicketSource;
  root: string;
  /** A folder of files to attach, outside the project. */
  files: string;
  /** Each comment PAWNEE-5 holds, as the tracker keeps it. */
  comments: () => string[];
  /** The names of the files the tracker received. */
  uploads: () => string[];
  /** The ref the tracker gives the n-th upload (1-based). */
  refFor: (n: number, name: string) => string;
  /** Extra checks on what reached the tracker. */
  sent: () => unknown;
}

const picturesFolder = (): string => {
  const files = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'contract-pictures-'))
  );
  fs.writeFileSync(path.join(files, 'a.png'), 'pit, drawn');
  fs.writeFileSync(path.join(files, 'b.png'), 'pit, filled');

  return files;
};

const openAt = (
  context: SourceContext
): { source: TicketSource; root: string } => ({
  source: createTicketSource(context),
  root: context.root,
});

/** `reject`: the file name whose upload the tracker refuses. */
const PICTURED: Array<[string, (reject?: string) => Pictured]> = [
  [
    'markdown',
    (reject) => {
      const context = base({});
      fs.writeFileSync(
        path.join(context.root, 'TASKS.md'),
        '# Tasks\n\n- [ ] PAWNEE-5: Volunteer sign-up form\n'
      );
      const folder = path.join(context.root, 'tickets', 'PAWNEE-5');

      if (reject !== undefined) {
        // A folder where the copy should land: the copy fails.
        fs.mkdirSync(path.join(folder, reject), { recursive: true });
      }

      const ticketFile = path.join(context.root, 'tickets', 'PAWNEE-5.md');

      return {
        source: createTicketSource(context),
        root: context.root,
        files: picturesFolder(),
        comments: () =>
          fs.existsSync(ticketFile)
            ? (
                fs.readFileSync(ticketFile, 'utf8').split('## Comments')[1] ??
                ''
              )
                .split(/\n(?=- )/)
                .map((one) => one.trim())
                .filter((one) => one !== '')
            : [],
        uploads: () =>
          fs.existsSync(folder)
            ? fs
                .readdirSync(folder)
                .filter((name) => fs.statSync(path.join(folder, name)).isFile())
            : [],
        refFor: (_n, name) => `./PAWNEE-5/${name}`,
        sent: () => null,
      };
    },
  ],
  [
    'linear',
    (reject) => {
      const fake = createLinearFake({
        viewer: leslie,
        rejectUploads: reject === undefined ? [] : [reject],
      });
      fake.add({ identifier: 'PAWNEE-5', title: 'Volunteer sign-up form' });

      return {
        ...openAt(
          base({
            config: {
              source: 'linear',
              statuses: PAWNEE_STATUSES,
              team: 'PAWNEE',
              prefix: 'PAWNEE',
            },
            tokens: { linear: 'lin_api_test' },
            fetch: fake.fetch,
          })
        ),
        files: picturesFolder(),
        comments: () => fake.comments.map((comment) => comment.body),
        uploads: () => fake.uploads.map((upload) => upload.filename),
        refFor: (n, name) => `https://uploads.linear.app/pawnee/${n}/${name}`,
        sent: () => ({
          fileUploads: fake
            .operations()
            .filter((operation) => operation === 'LambdaFileUpload').length,
          // The presigned PUT never carries the key.
          keyOnUpload: fake.uploads.some(
            (upload) => upload.headers.authorization !== undefined
          ),
        }),
      };
    },
  ],
  [
    'jira',
    (reject) => {
      const fake = createJiraFake({
        issues: [{ key: 'PAWNEE-5', summary: 'Volunteer sign-up form' }],
        rejectAttachments: reject === undefined ? [] : [reject],
      });
      const issue = () =>
        fake.state.issues.find((one) => one.key === 'PAWNEE-5');

      return {
        ...openAt(
          base({
            config: {
              source: 'jira',
              statuses: JIRA_FAKE_STATUSES,
              site: JIRA_FAKE_SITE,
              project: JIRA_FAKE_PROJECT,
              prefix: 'PAWNEE',
            },
            tokens: { jira: { email: leslie.email, apiToken: 'jira-test' } },
            fetch: fake.fetch,
          })
        ),
        files: picturesFolder(),
        comments: () =>
          (issue()?.comments ?? []).map((comment) =>
            JSON.stringify(comment.body)
          ),
        uploads: () =>
          (issue()?.attachments ?? []).map((attachment) => attachment.filename),
        refFor: (n) =>
          `${JIRA_FAKE_SITE}/rest/api/3/attachment/content/${
            fake.state.issues.find((one) => one.key === 'PAWNEE-5')
              ?.attachments[n - 1]?.id ?? '?'
          }`,
        sent: () => ({
          noCheck: fake.state.requests
            .filter((request) => request.path.endsWith('/attachments'))
            .every(
              (request) => request.headers['x-atlassian-token'] === 'no-check'
            ),
          media: (issue()?.comments ?? []).some((comment) =>
            JSON.stringify(comment.body).includes('"media')
          ),
        }),
      };
    },
  ],
];

/** The text a comment holds, whatever the tracker stores it as. */
const linkedIn = (
  name: string,
  comment: string,
  alt: string,
  ref: string
): boolean =>
  name === 'jira'
    ? comment.includes(
        JSON.stringify({
          type: 'text',
          text: alt,
          marks: [{ type: 'link', attrs: { href: ref } }],
        })
      )
    : comment.includes(`![${alt}](${ref})`);

describe('the ticket contract: files and pictures', () => {
  it.each(PICTURED)('%s: attach gives a ref', async (name, open) => {
    const pictured = open();
    const { ref } = await pictured.source.attach(
      'PAWNEE-5',
      path.join(pictured.files, 'a.png'),
      { alt: 'the pit' }
    );

    expect(ref).toBe(pictured.refFor(1, 'a.png'));
    expect(pictured.uploads()).toEqual(['a.png']);

    if (name === 'markdown') {
      expect(
        fs.readFileSync(
          path.join(pictured.root, 'tickets', 'PAWNEE-5', 'a.png'),
          'utf8'
        )
      ).toBe('pit, drawn');
    }
  });

  it.each(PICTURED)(
    '%s: attaching a missing file attaches nothing',
    async (_name, open) => {
      const pictured = open();

      await expect(
        pictured.source.attach(
          'PAWNEE-5',
          path.join(pictured.files, 'gone.png')
        )
      ).rejects.toThrow('gone.png');
      expect(pictured.uploads()).toEqual([]);
    }
  );

  it.each(PICTURED)(
    '%s: comment --image uploads first, then links the picture',
    async (name, open) => {
      const pictured = open();
      await pictured.source.comment(
        'PAWNEE-5',
        'Ann Perkins: the form, as drawn.',
        {
          images: [
            { path: path.join(pictured.files, 'a.png'), alt: 'the form' },
          ],
        }
      );
      const ref = pictured.refFor(1, 'a.png');
      const [comment, ...others] = pictured.comments();

      expect(others).toEqual([]);
      expect(pictured.uploads()).toEqual(['a.png']);
      expect(linkedIn(name, comment ?? '', 'the form', ref)).toBe(true);

      if (name === 'markdown') {
        expect(comment).toBe(
          `- Leslie Knope: Ann Perkins: the form, as drawn.\n  ![the form](${ref})`
        );
      }

      expect(pictured.sent()).toEqual(
        {
          markdown: null,
          linear: { fileUploads: 1, keyOnUpload: false },
          jira: { noCheck: true, media: false },
        }[name]
      );
    }
  );

  it.each(PICTURED)(
    '%s: {{image:0}} is replaced where it stands; an image with no token comes last',
    async (name, open) => {
      const pictured = open();
      await pictured.source.comment(
        'PAWNEE-5',
        'Before {{image:0}} and after.',
        {
          images: [
            { path: path.join(pictured.files, 'a.png'), alt: 'drawn' },
            { path: path.join(pictured.files, 'b.png'), alt: 'filled' },
          ],
        }
      );
      const [comment = ''] = pictured.comments();
      const a = pictured.refFor(1, 'a.png');
      const b = pictured.refFor(2, 'b.png');

      expect(pictured.uploads()).toEqual(['a.png', 'b.png']);
      expect(linkedIn(name, comment, 'drawn', a)).toBe(true);
      expect(linkedIn(name, comment, 'filled', b)).toBe(true);
      expect(comment).not.toContain('{{image:');

      const expected: Record<string, string> = {
        markdown: `- Leslie Knope: Before ![drawn](${a}) and after.\n  ![filled](${b})`,
        linear: `Before ![drawn](${a}) and after.\n\n![filled](${b})`,
      };

      if (expected[name] !== undefined) {
        expect(comment).toBe(expected[name]);
      }
    }
  );

  it.each(PICTURED)(
    '%s: a second image whose upload fails posts no comment',
    async (_name, open) => {
      const pictured = open('b.png');

      await expect(
        pictured.source.comment('PAWNEE-5', 'Ann Perkins: both pits.', {
          images: [
            { path: path.join(pictured.files, 'a.png'), alt: 'drawn' },
            { path: path.join(pictured.files, 'b.png'), alt: 'filled' },
          ],
        })
      ).rejects.toThrow();
      expect(pictured.comments()).toEqual([]);
    }
  );
});
