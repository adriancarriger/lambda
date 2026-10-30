import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { postVisualMisses } from '../../verdict/visualMisses';
import { type VisualVerdict } from '../../verdict/visualStore';
import { type SourceContext } from '../context';
import { createJiraSource } from '../jira';
import { type AdfDoc } from '../jira-adf';
import { findNext } from '../source';
import {
  JIRA_FAKE_PROJECT,
  JIRA_FAKE_SITE,
  JIRA_FAKE_STATUSES,
  type JiraFakeOptions,
  createJiraFake,
} from './fakes/jiraFake';

const TOKENS = {
  jira: { email: 'leslie@pawnee.gov', apiToken: 'jira_token_test123' },
};

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-jira-')));

const setup = (
  options: JiraFakeOptions = {},
  overrides: Partial<SourceContext> = {}
) => {
  const fake = createJiraFake(options);
  const context: SourceContext = {
    root: tmp(),
    config: {
      source: 'jira',
      statuses: JIRA_FAKE_STATUSES,
      site: JIRA_FAKE_SITE,
      project: JIRA_FAKE_PROJECT,
    },
    tokens: TOKENS,
    env: {},
    fetch: fake.fetch,
    runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
    ...overrides,
  };

  return { fake, context, source: createJiraSource(context) };
};

const doc = (...content: AdfDoc['content']): AdfDoc => ({
  type: 'doc',
  version: 1,
  content,
});

const fieldsOf = (body: unknown): Record<string, unknown> => {
  const fields =
    typeof body === 'object' && body !== null && 'fields' in body
      ? body.fields
      : undefined;

  return typeof fields === 'object' && fields !== null
    ? Object.fromEntries(Object.entries(fields))
    : {};
};

/** `push` is a ticket method here, not an array's. */
const pushOf = (source: { push: (id: string) => Promise<string> }) =>
  source.push.bind(source);

const PARKS = [
  { key: 'PAWNEE-1', summary: 'Park map page' },
  { key: 'PAWNEE-2', summary: 'Volunteer sign-up form' },
  { key: 'PAWNEE-3', summary: 'Lot 48 pit photo gallery' },
];

describe('Jira tickets', () => {
  it('refuses a status no transition reaches, naming it and the transitions there are', async () => {
    const { source, fake } = setup({
      issues: PARKS,
      transitions: { Backlog: ['In Progress', "Won't Do"] },
    });

    await expect(
      source.update('PAWNEE-3', { status: 'ready' })
    ).rejects.toThrow(
      'Jira can\'t move PAWNEE-3 to "Selected for Development": no transition reaches it from "Backlog". Transitions from here: In Progress, Won\'t Do.'
    );
    expect(fake.writes()).toEqual([]);
  });

  it('a refused move changes nothing else in the same update, the title included', async () => {
    const { source, fake } = setup({
      issues: PARKS,
      transitions: { Backlog: ['In Progress', "Won't Do"] },
    });

    await expect(
      source.update('PAWNEE-3', { title: 'Lot 48 photos', status: 'ready' })
    ).rejects.toThrow(
      'Jira can\'t move PAWNEE-3 to "Selected for Development"'
    );
    expect(fake.writes()).toEqual([]);
    expect(fake.state.issues.find((i) => i.key === 'PAWNEE-3')?.summary).toBe(
      'Lot 48 pit photo gallery'
    );
  });

  it('create names the issue it made when the status move then fails', async () => {
    const { source } = setup({
      issues: PARKS,
      transitions: { Backlog: ['In Progress', "Won't Do"] },
    });

    await expect(
      source.create({ title: 'Lot 48', status: 'ready' })
    ).rejects.toThrow(
      'Created PAWNEE-4, but Jira can\'t move PAWNEE-4 to "Selected for Development"'
    );
  });

  it('refuses to place a ticket twice, writing nothing', async () => {
    const { source, fake } = setup({ issues: PARKS });

    await expect(
      source.place(['PAWNEE-1', 'PAWNEE-1'], 'PAWNEE-3')
    ).rejects.toThrow("Can't place a ticket twice: PAWNEE-1 is repeated.");
    expect(fake.writes()).toEqual([]);
  });

  it('round-trips underscores and asterisks in plain text unchanged', async () => {
    const description = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Edit my_var_name.ts, and 2 * 3 * 4.' }],
    });
    const { source, fake } = setup({
      issues: [{ key: 'PAWNEE-1', summary: 'Park map page', description }],
    });

    await source.pull('PAWNEE-1');
    await pushOf(source)('PAWNEE-1');

    expect(fake.writes()).toEqual([
      expect.objectContaining({ body: { fields: { description } } }),
    ]);
  });

  it('pushes text that only looks like a placeholder', async () => {
    const description = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: '<!-- adf:table:abc --> is just text' }],
    });
    const { source, fake } = setup({
      issues: [{ key: 'PAWNEE-1', summary: 'Park map page', description }],
    });

    await source.pull('PAWNEE-1');
    await pushOf(source)('PAWNEE-1');

    expect(fake.writes()).toEqual([
      expect.objectContaining({ body: { fields: { description } } }),
    ]);
  });

  it('moves a ticket with the one transition that reaches the mapped status', async () => {
    const { source, fake } = setup({ issues: PARKS });

    const ticket = await source.update('PAWNEE-3', { status: 'building' });

    expect(ticket.status).toBe('building');
    expect(fake.state.issues.find((i) => i.key === 'PAWNEE-3')?.status).toBe(
      'In Progress'
    );
  });

  it('pulls a table as a placeholder and refuses to push it, naming table', async () => {
    const { source, fake } = setup({
      issues: [
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          description: doc(
            { type: 'paragraph', content: [{ type: 'text', text: 'Budget:' }] },
            { type: 'table', content: [] }
          ),
        },
      ],
    });

    const dir = await source.pull('PAWNEE-1');
    const description = fs.readFileSync(
      path.join(dir, 'description.md'),
      'utf8'
    );

    expect(dir).toMatch(/\.lambda\/pulled\/PAWNEE-1$/);
    expect(description).toMatch(/<!-- adf:table:[A-Za-z0-9+/=]+ -->/);
    await expect(pushOf(source)('PAWNEE-1')).rejects.toThrow('"table"');
    expect(fake.writes()).toEqual([]);
  });

  it('round-trips a description of paragraphs, a list and a link to the same ADF', async () => {
    const description = doc(
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Pins for each park.' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Ramsett Park',
                    marks: [
                      { type: 'link', attrs: { href: 'https://pawnee.gov' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }
    );
    const { source, fake } = setup({
      issues: [{ key: 'PAWNEE-1', summary: 'Park map page', description }],
    });

    await source.pull('PAWNEE-1');
    await pushOf(source)('PAWNEE-1');

    expect(fake.writes()).toEqual([
      expect.objectContaining({
        method: 'PUT',
        path: '/rest/api/3/issue/PAWNEE-1',
        body: { fields: { description } },
      }),
    ]);
  });

  it('blocks with one Blocks link: the blocker inward, the blocked outward', async () => {
    const { source, fake } = setup({ issues: PARKS });

    await source.block('PAWNEE-2', 'PAWNEE-1');

    expect(fake.writes()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/rest/api/3/issueLink',
        body: {
          type: { name: 'Blocks' },
          outwardIssue: { key: 'PAWNEE-1' },
          inwardIssue: { key: 'PAWNEE-2' },
        },
      }),
    ]);
    expect((await source.get('PAWNEE-2')).blockedBy).toEqual(['PAWNEE-1']);
    expect((await source.get('PAWNEE-1')).blockedBy).toEqual([]);

    await source.unblock('PAWNEE-2', 'PAWNEE-1');

    expect((await source.get('PAWNEE-2')).blockedBy).toEqual([]);
  });

  it('refuses to block by a ticket that does not exist, writing nothing', async () => {
    const { source, fake } = setup({ issues: PARKS });

    await expect(source.block('PAWNEE-2', 'PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
    expect(fake.writes()).toEqual([]);
  });

  it('creates a Task, and a sub-task for a child, never setting the reporter', async () => {
    const { source, fake } = setup({ issues: PARKS });

    const lot = await source.create({ title: 'Lot 48' });
    const pit = await source.create({
      title: 'Fill the pit',
      parent: 'PAWNEE-3',
    });
    const posts = fake
      .writes()
      .filter(
        (request) =>
          request.method === 'POST' && request.path === '/rest/api/3/issue'
      )
      .map((request) => fieldsOf(request.body));

    expect(posts.map((fields) => fields.issuetype)).toEqual([
      { name: 'Task' },
      { name: 'Sub-task' },
    ]);
    expect(posts[1]?.parent).toEqual({ key: 'PAWNEE-3' });
    expect(posts.every((fields) => !('reporter' in fields))).toBe(true);
    expect(lot).toMatchObject({ id: 'PAWNEE-4', status: 'planning' });
    expect(pit).toMatchObject({ id: 'PAWNEE-5', parent: 'PAWNEE-3' });
    expect((await source.get('PAWNEE-3')).children).toEqual(['PAWNEE-5']);
  });

  it('refuses a child when the project has no sub-task type, naming what is missing and the types', async () => {
    const { source, fake } = setup({
      issues: PARKS,
      issueTypes: [
        { id: '1', name: 'Task', subtask: false },
        { id: '2', name: 'Bug', subtask: false },
      ],
    });

    await expect(
      source.create({ title: 'Fill the pit', parent: 'PAWNEE-3' })
    ).rejects.toThrow(
      'Jira project PAWNEE has no sub-task issue type (subtask: true) for a child of PAWNEE-3. Its types: Task, Bug.'
    );
    expect(fake.writes()).toEqual([]);
  });

  it('refuses a top-level create when the project has no Task type, naming the types', async () => {
    const { source, fake } = setup({
      issues: PARKS,
      issueTypes: [
        { id: '1', name: 'Story', subtask: false },
        { id: '2', name: 'Bug', subtask: false },
        { id: '3', name: 'Sub-task', subtask: true },
      ],
    });

    await expect(source.create({ title: 'Lot 48' })).rejects.toThrow(
      'Jira project PAWNEE has no "Task" issue type. Its types: Story, Bug, Sub-task.'
    );
    expect(fake.writes()).toEqual([]);
  });

  it('lists in rank order, not creation order, and children by rank too', async () => {
    const { source } = setup({
      issues: [
        { key: 'PAWNEE-5', summary: 'Lot 48' },
        { key: 'PAWNEE-2', summary: 'Volunteer sign-up form' },
        { key: 'PAWNEE-1', summary: 'Park map page' },
        { key: 'PAWNEE-4', summary: 'Pins', parent: 'PAWNEE-1' },
        { key: 'PAWNEE-3', summary: 'Map tiles', parent: 'PAWNEE-1' },
      ],
    });

    expect((await source.list()).map((ticket) => ticket.id)).toEqual([
      'PAWNEE-5',
      'PAWNEE-2',
      'PAWNEE-1',
      'PAWNEE-4',
      'PAWNEE-3',
    ]);
    expect((await source.get('PAWNEE-1')).children).toEqual([
      'PAWNEE-4',
      'PAWNEE-3',
    ]);
  });

  it("sends labels by the codebase's names and reads them back as Lambda keys", async () => {
    const fake = createJiraFake({
      issues: [
        {
          key: 'PAWNEE-2',
          summary: 'Volunteer sign-up form',
          labels: ['triage'],
        },
      ],
    });
    const source = createJiraSource({
      root: tmp(),
      config: {
        source: 'jira',
        statuses: JIRA_FAKE_STATUSES,
        site: JIRA_FAKE_SITE,
        project: JIRA_FAKE_PROJECT,
        labels: { planned: 'Planned' },
      },
      tokens: TOKENS,
      env: {},
      fetch: fake.fetch,
      runner: null,
    });

    const ticket = await source.update('PAWNEE-2', {
      labels: ['planned', 'urgent', 'triage'],
    });

    expect(fake.writes()).toEqual([
      expect.objectContaining({
        method: 'PUT',
        path: '/rest/api/3/issue/PAWNEE-2',
        body: { update: { labels: [{ add: 'Planned' }, { add: 'urgent' }] } },
      }),
    ]);
    expect(fake.state.issues[0]?.labels).toEqual([
      'triage',
      'Planned',
      'urgent',
    ]);
    expect(ticket.labels).toEqual(['triage', 'planned', 'urgent']);
  });

  it('refuses with no Jira credentials anywhere, before any request', async () => {
    const { source, fake } = setup({ issues: PARKS }, { tokens: undefined });

    await expect(source.list()).rejects.toThrow(
      'No Jira key: set tokens.jira (email and apiToken) in ~/.lambda/config.json, or LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN.'
    );
    expect(fake.state.requests).toEqual([]);
  });

  it('signs in with the environment pair over the config file', async () => {
    const { source, fake } = setup(
      { issues: PARKS },
      {
        env: {
          LAMBDA_JIRA_EMAIL: 'ben@pawnee.gov',
          LAMBDA_JIRA_TOKEN: 'env_token',
        },
      }
    );

    await source.get('PAWNEE-1');

    expect(fake.state.requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('ben@pawnee.gov:env_token').toString('base64')}`
    );
  });

  it('says a refused key plainly, without the key', async () => {
    const { source } = setup({ issues: PARKS, failWith: 401 });

    const error = await source.list().catch((caught: unknown) => caught);

    expect(error).toEqual(new Error('Jira refused the key (401).'));
    expect(String(error)).not.toContain('jira_token_test123');
  });

  it('says a 403 plainly too', async () => {
    const { source } = setup({ issues: PARKS, failWith: 403 });

    await expect(source.get('PAWNEE-1')).rejects.toThrow(
      'Jira refused the key (403).'
    );
  });

  it("gives any other refusal's status and Jira's own messages, with no retry", async () => {
    const { source, fake } = setup({
      issues: PARKS,
      failWith: 400,
      failBody: {
        errorMessages: ['The issue could not be saved.'],
        errors: { summary: 'You must specify a summary.' },
      },
    });

    await expect(source.list()).rejects.toThrow(
      'Jira answered 400: The issue could not be saved.; summary: You must specify a summary.'
    );
    expect(fake.state.requests).toHaveLength(1);
  });

  it('checks the mapped statuses on the first call, whichever method it is', async () => {
    const { source, fake } = setup({
      issues: PARKS,
      statuses: ['Backlog', 'In Progress', 'Blocked', 'Done', "Won't Do"],
    });

    await expect(source.block('PAWNEE-2', 'PAWNEE-1')).rejects.toThrow(
      'tickets.statuses.ready is "Selected for Development", but Jira project PAWNEE has no status by that name.'
    );
    await expect(source.comment('PAWNEE-2', 'Hi Ann')).rejects.toThrow(
      'tickets.statuses.ready'
    );
    expect(fake.writes()).toEqual([]);
  });

  it('skips a ticket blocked by an id that no longer exists', async () => {
    const { source, fake } = setup({
      issues: [
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          status: 'Selected for Development',
        },
        {
          key: 'PAWNEE-2',
          summary: 'Volunteer sign-up form',
          status: 'Selected for Development',
        },
      ],
    });
    fake.state.links = [{ id: '1', blocker: 'PAWNEE-9', blocked: 'PAWNEE-1' }];

    expect((await source.list())[0]?.blockedBy).toEqual(['PAWNEE-9']);
    expect((await source.next())?.id).toBe('PAWNEE-2');
  });

  it('refuses to place after a ticket that does not exist', async () => {
    const { source, fake } = setup({ issues: PARKS });

    await expect(source.place(['PAWNEE-1'], 'PAWNEE-99')).rejects.toThrow(
      "PAWNEE-99 isn't a ticket I can read."
    );
    expect(fake.writes()).toEqual([]);
  });

  it("names an id that isn't a ticket", async () => {
    const { source } = setup({ issues: PARKS });

    await expect(source.get('PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
  });

  it('refuses a mapped status the project does not have, listing its statuses', async () => {
    const { source } = setup({
      issues: PARKS,
      statuses: ['Backlog', 'In Progress', 'Blocked', 'Done', "Won't Do"],
    });

    await expect(source.list()).rejects.toThrow(
      'tickets.statuses.ready is "Selected for Development", but Jira project PAWNEE has no status by that name. Its statuses: Backlog, In Progress, Blocked, Done, Won\'t Do.'
    );
  });

  it("reads the reporter from the issue's reporter field", async () => {
    const { source } = setup({
      issues: [
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          reporter: {
            displayName: 'Ron Swanson',
            emailAddress: 'ron@pawnee.gov',
          },
        },
        { key: 'PAWNEE-2', summary: 'Volunteer sign-up form', reporter: null },
      ],
    });

    expect((await source.get('PAWNEE-1')).reporter).toEqual({
      name: 'Ron Swanson',
      email: 'ron@pawnee.gov',
    });
    expect((await source.get('PAWNEE-2')).reporter).toBeNull();
  });

  it('lists in rank order with children after their parent, across pages', async () => {
    const { source } = setup({
      pageSize: 2,
      issues: [
        { key: 'PAWNEE-1', summary: 'Park map page' },
        { key: 'PAWNEE-2', summary: 'Volunteer sign-up form' },
        { key: 'PAWNEE-4', summary: 'Pins', parent: 'PAWNEE-1' },
        { key: 'PAWNEE-3', summary: 'Map tiles', parent: 'PAWNEE-1' },
      ],
    });

    const tickets = await source.list();

    expect(tickets.map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-4',
      'PAWNEE-3',
      'PAWNEE-2',
    ]);
    expect(tickets[0]?.children).toEqual(['PAWNEE-4', 'PAWNEE-3']);
  });

  it('reorders children and places a block with the rank endpoint', async () => {
    const { source, fake } = setup({
      issues: [
        { key: 'PAWNEE-1', summary: 'Park map page' },
        { key: 'PAWNEE-3', summary: 'Map tiles', parent: 'PAWNEE-1' },
        { key: 'PAWNEE-4', summary: 'Pins', parent: 'PAWNEE-1' },
        { key: 'PAWNEE-2', summary: 'Volunteer sign-up form' },
        { key: 'PAWNEE-5', summary: 'Lot 48' },
      ],
    });

    await source.reorder('PAWNEE-1', ['PAWNEE-4', 'PAWNEE-3']);
    await source.place(['PAWNEE-5'], 'PAWNEE-1');

    expect(
      fake
        .writes()
        .every((request) => request.path === '/rest/agile/1.0/issue/rank')
    ).toBe(true);
    expect((await source.list()).map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-4',
      'PAWNEE-3',
      'PAWNEE-5',
      'PAWNEE-2',
    ]);
    await expect(
      source.reorder('PAWNEE-1', ['PAWNEE-4', 'PAWNEE-2'])
    ).rejects.toThrow('missing PAWNEE-3');
  });

  it("reads back a comment's HTML-comment marker exactly as it was posted", async () => {
    const { source } = setup({ issues: PARKS });
    const marker = '<!-- visual-check:PAWNEE-2:2026-10-23T10:00:00.000Z -->';

    await source.comment(
      'PAWNEE-2',
      [marker, '### 🎨 Visual check: shipped with misses', '', 'Text.'].join(
        '\n'
      )
    );

    const comments = await source.comments('PAWNEE-2');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(marker);
  });

  it('posts the visual misses once, however many times the record is posted', async () => {
    const { source, fake } = setup({ issues: PARKS });
    const root = tmp();
    const expected = path.join(root, 'expected.png');
    const actual = path.join(root, 'actual.png');
    fs.writeFileSync(expected, 'png');
    fs.writeFileSync(actual, 'png');
    fs.writeFileSync(
      path.join(root, 'lambda.json'),
      JSON.stringify({ name: 'Pawnee Parks app' })
    );
    const verdict: VisualVerdict = {
      ticketId: 'PAWNEE-2',
      result: 'SHIPPED_WITH_MISSES',
      rounds: 4,
      issues: [
        {
          severity: 'medium',
          where: 'Sign-up button',
          what: 'below the form, not beside it',
          scenarioId: 'volunteer-form',
          situation: 'Volunteer form — empty',
          expected: 'expected.png',
          actual: 'actual.png',
        },
      ],
      recordedAt: '2026-10-23T10:00:00.000Z',
    };
    const deps = {
      projectRoot: root,
      source,
      compose: async ({
        expected: from,
        out,
      }: {
        expected: string;
        out: string;
      }) => fs.copyFileSync(from, out),
    };

    await postVisualMisses(verdict, deps);
    await postVisualMisses(verdict, deps);

    expect(fake.state.issues[1]?.comments).toHaveLength(1);
  });

  it('keeps a block reason as a marker comment, and reads it back', async () => {
    const { source } = setup({ issues: PARKS });

    const ticket = await source.update('PAWNEE-2', {
      status: 'blocked',
      reason: 'Ann Perkins is out',
    });

    expect(ticket).toMatchObject({
      status: 'blocked',
      blockReason: 'Ann Perkins is out',
    });
  });

  it('refuses to delete a ticket that still has children', async () => {
    const { source, fake } = setup({
      issues: [
        { key: 'PAWNEE-1', summary: 'Park map page' },
        { key: 'PAWNEE-3', summary: 'Map tiles', parent: 'PAWNEE-1' },
      ],
    });

    await expect(source.delete('PAWNEE-1', 'not needed')).rejects.toThrow(
      'PAWNEE-1 still has children: PAWNEE-3.'
    );
    expect(fake.writes()).toEqual([]);

    await source.delete('PAWNEE-3', 'not needed');

    expect(fake.writes()).toEqual([
      expect.objectContaining({
        method: 'DELETE',
        path: '/rest/api/3/issue/PAWNEE-3',
      }),
    ]);
  });

  it('downloads attachments with the token only from the Jira site', async () => {
    const { source, fake } = setup({
      issues: [
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          attachments: [
            {
              id: '1',
              filename: 'map.png',
              content: `${JIRA_FAKE_SITE}/rest/api/3/attachment/content/1`,
            },
            {
              id: '2',
              filename: '../evil.png',
              content: 'https://pawnee.atlassian.net.evil.test/b.png',
            },
          ],
        },
      ],
      files: {
        [`${JIRA_FAKE_SITE}/rest/api/3/attachment/content/1`]: 'map',
        'https://pawnee.atlassian.net.evil.test/b.png': 'evil',
      },
    });

    const dir = await source.pull('PAWNEE-1');
    const download = (url: string) =>
      fake.state.requests.find((request) => request.url === url);

    expect(
      download(`${JIRA_FAKE_SITE}/rest/api/3/attachment/content/1`)?.headers
        .authorization
    ).toMatch(/^Basic /);
    expect(
      download('https://pawnee.atlassian.net.evil.test/b.png')?.headers
        .authorization
    ).toBeUndefined();
    expect(fs.readdirSync(path.join(dir, 'attachments')).sort()).toEqual([
      'evil.png',
      'map.png',
    ]);
  });

  it('runs next over the queue, skipping a blocked ticket', async () => {
    const { source } = setup({
      issues: [
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          status: 'Selected for Development',
        },
        {
          key: 'PAWNEE-2',
          summary: 'Volunteer sign-up form',
          status: 'Selected for Development',
        },
        { key: 'PAWNEE-3', summary: 'Lot 48', status: 'Backlog' },
      ],
    });

    await source.block('PAWNEE-1', 'PAWNEE-3');

    expect((await source.next())?.id).toBe('PAWNEE-2');
  });

  it.each(['waiting_on_ron', 'PR [#12] stuck', '*star*', 'a <b> & `c`'])(
    'keeps the block reason %j exactly as given',
    async (reason) => {
      const { source, fake } = setup({ issues: PARKS });

      const ticket = await source.update('PAWNEE-2', {
        status: 'blocked',
        reason,
      });

      expect(ticket.blockReason).toBe(reason);
      expect((await source.list())[1]?.blockReason).toBe(reason);
      expect(fake.state.issues[1]?.comments.at(-1)?.body).toEqual(
        doc({
          type: 'paragraph',
          content: [
            { type: 'text', text: `Lambda marked this blocked: ${reason}` },
          ],
        })
      );
    }
  );

  it('posts a marker on every move into blocked, so an old reason never comes back', async () => {
    const { source, fake } = setup({ issues: PARKS });

    await source.update('PAWNEE-2', {
      status: 'blocked',
      reason: 'Ann Perkins is out',
    });
    await source.update('PAWNEE-2', { status: 'ready' });
    const again = await source.update('PAWNEE-2', { status: 'blocked' });

    expect(again).toMatchObject({ status: 'blocked', blockReason: null });
    expect(fake.state.issues[1]?.comments).toHaveLength(2);
  });

  it('never reads a person\'s own "Blocked: …" comment as the reason', async () => {
    const { source } = setup({
      issues: [
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          status: 'Blocked',
          comments: [
            {
              id: '1',
              author: { displayName: 'Ron Swanson' },
              body: doc({
                type: 'paragraph',
                content: [{ type: 'text', text: 'Blocked: x' }],
              }),
              created: '2026-10-20T10:00:00.000+0000',
            },
          ],
        },
      ],
    });

    expect((await source.get('PAWNEE-1')).blockReason).toBeNull();
    expect((await source.list())[0]?.blockReason).toBeNull();
  });

  it('hands out a ready ticket whose epic lives in another project', async () => {
    const { source } = setup({
      issues: [
        { key: 'EAGLETON-1', summary: 'Merger epic' },
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          status: 'Selected for Development',
          parent: 'EAGLETON-1',
        },
      ],
    });

    const tickets = await source.list();

    expect(tickets.map((ticket) => [ticket.id, ticket.parent])).toEqual([
      ['PAWNEE-1', null],
    ]);
    expect((await source.next())?.id).toBe('PAWNEE-1');
    expect((await source.get('PAWNEE-1')).parent).toBe('EAGLETON-1');
  });

  it("lists without downloading comments, reading them only for a blocked ticket's reason", async () => {
    const comment = {
      id: '1',
      author: { displayName: 'Ron Swanson' },
      body: doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'No.' }],
      }),
      created: '2026-10-20T10:00:00.000+0000',
    };
    const { source, fake } = setup({
      issues: [
        { key: 'PAWNEE-1', summary: 'Park map page', comments: [comment] },
        {
          key: 'PAWNEE-2',
          summary: 'Volunteer sign-up form',
          status: 'Blocked',
          comments: [comment],
        },
      ],
    });

    await source.list();

    const asksForComments = fake.state.requests
      .filter((request) => {
        const fields =
          typeof request.body === 'object' &&
          request.body !== null &&
          'fields' in request.body &&
          Array.isArray(request.body.fields)
            ? request.body.fields.map(String)
            : (new URL(request.url).searchParams.get('fields') ?? '').split(
                ','
              );

        return fields.includes('comment');
      })
      .map((request) => `${request.method} ${request.path}`);

    expect(asksForComments).toEqual(['GET /rest/api/3/issue/PAWNEE-2']);
  });

  it('refuses a search answer with no issues rather than read it as an empty project', async () => {
    const { source } = setup({
      issues: PARKS,
      answers: {
        '/rest/api/3/search/jql': { body: JSON.stringify({ isLast: true }) },
      },
    });

    await expect(source.list()).rejects.toThrow(
      'Jira sent an unexpected answer from /rest/api/3/search/jql.'
    );
  });

  it('says plainly when Jira answers 200 with a web page, not JSON', async () => {
    const { source } = setup({
      issues: PARKS,
      answers: {
        '/rest/api/3/project/PAWNEE/statuses': {
          body: '<!DOCTYPE html><html><body>Sign in</body></html>',
        },
      },
    });

    await expect(source.list()).rejects.toThrow(
      "Jira sent an answer from /rest/api/3/project/PAWNEE/statuses that isn't JSON (a sign-in page?). Check tickets.site in lambda.json."
    );
  });

  it('names each issue a partly refused rank left where it was, with Jira’s reason', async () => {
    const { source, fake } = setup({
      issues: [...PARKS, { key: 'PAWNEE-4', summary: 'Lot 48' }],
      rankErrors: { 'PAWNEE-4': 'Rank is locked' },
    });

    await expect(
      source.place(['PAWNEE-3', 'PAWNEE-4'], 'PAWNEE-1')
    ).rejects.toThrow("Jira couldn't rank PAWNEE-4 (Rank is locked).");
    expect(fake.state.issues.map((issue) => issue.key)).toEqual([
      'PAWNEE-1',
      'PAWNEE-3',
      'PAWNEE-2',
      'PAWNEE-4',
    ]);
  });

  describe("Blocks links, in Jira's own direction", () => {
    it('reads a blocker linked in Jira itself: the blocked issue sees it as inwardIssue', async () => {
      const { source } = setup({
        issues: PARKS,
        answers: {
          '/rest/api/3/issue/PAWNEE-2': {
            body: JSON.stringify({
              key: 'PAWNEE-2',
              fields: {
                summary: 'Volunteer sign-up form',
                project: { key: 'PAWNEE' },
                status: { name: 'Backlog' },
                issuelinks: [
                  {
                    id: '10001',
                    type: {
                      name: 'Blocks',
                      inward: 'is blocked by',
                      outward: 'blocks',
                    },
                    inwardIssue: { key: 'PAWNEE-1' },
                  },
                  {
                    id: '10002',
                    type: {
                      name: 'Blocks',
                      inward: 'is blocked by',
                      outward: 'blocks',
                    },
                    outwardIssue: { key: 'PAWNEE-3' },
                  },
                ],
              },
            }),
          },
        },
      });

      expect((await source.get('PAWNEE-2')).blockedBy).toEqual(['PAWNEE-1']);
    });

    it('lists the blocker on the blocked issue only', async () => {
      const { source, fake } = setup({ issues: PARKS });
      fake.state.links = [
        { id: '1', blocker: 'PAWNEE-1', blocked: 'PAWNEE-2' },
      ];

      const tickets = await source.list();

      expect(tickets.map((ticket) => [ticket.id, ticket.blockedBy])).toEqual([
        ['PAWNEE-1', []],
        ['PAWNEE-2', ['PAWNEE-1']],
        ['PAWNEE-3', []],
      ]);
    });

    it('unblocks only the link where the other issue blocks this one', async () => {
      const { source, fake } = setup({ issues: PARKS });
      fake.state.links = [
        { id: '1', blocker: 'PAWNEE-1', blocked: 'PAWNEE-2' },
        { id: '2', blocker: 'PAWNEE-2', blocked: 'PAWNEE-1' },
      ];

      await source.unblock('PAWNEE-2', 'PAWNEE-1');

      expect(fake.state.links).toEqual([
        { id: '2', blocker: 'PAWNEE-2', blocked: 'PAWNEE-1' },
      ]);
    });

    it("says so when a new link doesn't read back as a blocker", async () => {
      const { fake, context } = setup({ issues: PARKS });
      // Jira takes the link but files it the other way round.
      const source = createJiraSource({
        ...context,
        fetch: async (input, init) => {
          const url = String(input);

          if (
            url.endsWith('/rest/api/3/issueLink') &&
            init?.method === 'POST'
          ) {
            fake.state.links = [
              ...fake.state.links,
              { id: '9', blocker: 'PAWNEE-2', blocked: 'PAWNEE-1' },
            ];

            return new Response(null, { status: 201 });
          }

          return fake.fetch(input, init);
        },
      });

      await expect(source.block('PAWNEE-2', 'PAWNEE-1')).rejects.toThrow(
        'Jira took the link, but PAWNEE-2 does not read as blocked by PAWNEE-1.'
      );
    });

    it('lets a done blocker in another project stop blocking', async () => {
      const { source, fake } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            status: 'Selected for Development',
          },
          { key: 'EAGLETON-4', summary: 'Shared fence', status: 'Done' },
        ],
      });
      fake.state.links = [
        { id: '1', blocker: 'EAGLETON-4', blocked: 'PAWNEE-1' },
      ];

      expect((await source.list())[0]?.blockedBy).toEqual(['EAGLETON-4']);
      expect((await source.next())?.id).toBe('PAWNEE-1');
    });

    it('next hands out exactly what the queue would', async () => {
      const { source, fake } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            status: 'Selected for Development',
          },
          {
            key: 'PAWNEE-2',
            summary: 'Trail markers',
            status: 'Selected for Development',
          },
          { key: 'EAGLETON-4', summary: 'Shared fence', status: 'To Do' },
        ],
      });
      fake.state.links = [
        { id: '1', blocker: 'EAGLETON-4', blocked: 'PAWNEE-1' },
      ];

      const { tickets, outside } = await source.queue();

      expect((await source.next())?.id).toBe(
        findNext(tickets, {}, outside)?.id
      );
      expect((await source.next())?.id).toBe('PAWNEE-2');
    });

    it("gives a building pod's queue the other project's blocker status", async () => {
      const { source, fake } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            status: 'Selected for Development',
          },
          { key: 'EAGLETON-4', summary: 'Shared fence', status: 'Done' },
        ],
      });
      fake.state.links = [
        { id: '1', blocker: 'EAGLETON-4', blocked: 'PAWNEE-1' },
      ];

      const { tickets, outside } = await source.queue();

      expect(tickets.map((ticket) => ticket.id)).toEqual(['PAWNEE-1']);
      expect(outside.get('EAGLETON-4')).toBe('done');
    });

    it('keeps an open blocker in another project blocking', async () => {
      const { source, fake } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            status: 'Selected for Development',
          },
          { key: 'EAGLETON-4', summary: 'Shared fence', status: 'In Progress' },
        ],
      });
      fake.state.links = [
        { id: '1', blocker: 'EAGLETON-4', blocked: 'PAWNEE-1' },
      ];

      expect(await source.next()).toBeNull();
    });
  });

  describe("another project's issues", () => {
    const issues = [
      ...PARKS,
      { key: 'EAGLETON-5', summary: 'Eagleton gazebo' },
    ];
    const refused = "EAGLETON-5 isn't a ticket I can read.";

    it.each([
      [
        'get',
        (source: ReturnType<typeof setup>['source']) =>
          source.get('EAGLETON-5'),
      ],
      [
        'pull',
        (source: ReturnType<typeof setup>['source']) =>
          source.pull('EAGLETON-5'),
      ],
      [
        'update',
        (source: ReturnType<typeof setup>['source']) =>
          source.update('EAGLETON-5', { title: 'Ours now' }),
      ],
      [
        'comment',
        (source: ReturnType<typeof setup>['source']) =>
          source.comment('EAGLETON-5', 'Hi'),
      ],
      [
        'delete',
        (source: ReturnType<typeof setup>['source']) =>
          source.delete('EAGLETON-5', 'gone'),
      ],
      [
        'block',
        (source: ReturnType<typeof setup>['source']) =>
          source.block('EAGLETON-5', 'PAWNEE-1'),
      ],
      [
        'block --by',
        (source: ReturnType<typeof setup>['source']) =>
          source.block('PAWNEE-1', 'EAGLETON-5'),
      ],
      [
        'place',
        (source: ReturnType<typeof setup>['source']) =>
          source.place(['EAGLETON-5'], 'PAWNEE-1'),
      ],
      [
        'reorder',
        (source: ReturnType<typeof setup>['source']) =>
          source.reorder('EAGLETON-5', []),
      ],
    ])('refuses %s, writing nothing', async (_name, act) => {
      const { source, fake } = setup({ issues });

      await expect(act(source)).rejects.toThrow(refused);
      expect(fake.writes()).toEqual([]);
      expect(fake.state.issues.map((issue) => issue.key)).toContain(
        'EAGLETON-5'
      );
    });
  });

  describe('unblocking from a blocker out of reach', () => {
    it('unblocks from a blocker deleted since, and next hands the ticket out', async () => {
      const { source, fake } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            status: 'Selected for Development',
          },
          { key: 'PAWNEE-3', summary: 'Lot 48' },
        ],
      });
      await source.block('PAWNEE-1', 'PAWNEE-3');
      // Gone from Jira, while the link is still on PAWNEE-1.
      fake.state.issues = fake.state.issues.filter(
        (issue) => issue.key !== 'PAWNEE-3'
      );

      await source.unblock('PAWNEE-1', 'PAWNEE-3');

      expect(fake.state.links).toEqual([]);
      expect((await source.next())?.id).toBe('PAWNEE-1');
    });

    it('unblocks from an open blocker in another project', async () => {
      const { source, fake } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            status: 'Selected for Development',
          },
          { key: 'EAGLETON-4', summary: 'Shared fence', status: 'In Progress' },
        ],
      });
      fake.state.links = [
        { id: '1', blocker: 'EAGLETON-4', blocked: 'PAWNEE-1' },
      ];

      await source.unblock('PAWNEE-1', 'EAGLETON-4');

      expect(fake.state.links).toEqual([]);
      expect((await source.next())?.id).toBe('PAWNEE-1');
    });

    it('still refuses a blocker that is not a ticket id, writing nothing', async () => {
      const { source, fake } = setup({ issues: PARKS });

      await expect(source.unblock('PAWNEE-1', '../x')).rejects.toThrow(
        '"../x" isn\'t a ticket id'
      );
      expect(fake.writes()).toEqual([]);
    });
  });

  describe("a child in another project isn't a child here", () => {
    const issues = [
      { key: 'PAWNEE-1', summary: 'Park map page' },
      { key: 'PAWNEE-2', summary: 'Pins', parent: 'PAWNEE-1' },
      { key: 'EAGLETON-7', summary: 'Eagleton pins', parent: 'PAWNEE-1' },
    ];

    it("leaves it out of get's children", async () => {
      const { source } = setup({ issues });

      expect((await source.get('PAWNEE-1')).children).toEqual(['PAWNEE-2']);
    });

    it("doesn't ask for it in a reorder", async () => {
      const { source } = setup({ issues });

      await expect(
        source.reorder('PAWNEE-1', ['PAWNEE-2'])
      ).resolves.toBeUndefined();
    });

    it("doesn't refuse a delete over it", async () => {
      const { source, fake } = setup({
        issues: issues.filter((issue) => issue.key !== 'PAWNEE-2'),
      });

      await source.delete('PAWNEE-1', 'not needed');

      expect(fake.state.issues.map((issue) => issue.key)).toEqual([
        'EAGLETON-7',
      ]);
    });
  });

  describe('comments for blocked tickets', () => {
    const blocked = Array.from({ length: 12 }, (_, index) => ({
      key: `PAWNEE-${index + 1}`,
      summary: `Lot ${index + 1}`,
      status: 'Blocked',
    }));

    const asksForComments = (fake: ReturnType<typeof setup>['fake']) =>
      fake.state.requests.filter((request) =>
        (new URL(request.url).searchParams.get('fields') ?? '')
          .split(',')
          .includes('comment')
      );

    it('next reads no comments, as it never wants a reason', async () => {
      const { source, fake } = setup({ issues: blocked });

      expect(await source.next()).toBeNull();
      expect(asksForComments(fake)).toEqual([]);
    });

    it('list reads them a few at a time, never all at once', async () => {
      const { fake, context } = setup({ issues: blocked });
      const flight = { now: 0, most: 0 };
      const source = createJiraSource({
        ...context,
        fetch: async (input, init) => {
          const comments = new URL(String(input)).searchParams
            .get('fields')
            ?.split(',')
            .includes('comment');

          if (comments !== true) {
            return fake.fetch(input, init);
          }

          flight.now += 1;
          flight.most = Math.max(flight.most, flight.now);
          await new Promise((resolve) => setTimeout(resolve, 5));
          flight.now -= 1;

          return fake.fetch(input, init);
        },
      });

      const tickets = await source.list();

      expect(tickets).toHaveLength(12);
      expect(asksForComments(fake)).toHaveLength(12);
      expect(flight.most).toBeGreaterThan(1);
      expect(flight.most).toBeLessThanOrEqual(5);
    });
  });

  it('reads tickets when tickets.project is written in lower case', async () => {
    const { source } = setup(
      { issues: PARKS },
      {
        config: {
          source: 'jira',
          statuses: JIRA_FAKE_STATUSES,
          site: JIRA_FAKE_SITE,
          project: 'pawnee',
        },
      }
    );

    expect((await source.list()).map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-2',
      'PAWNEE-3',
    ]);
    expect((await source.get('PAWNEE-2')).title).toBe('Volunteer sign-up form');
  });

  describe('pull', () => {
    it.each([
      [
        'an empty file name',
        [{ id: '../../../x', filename: '', content: 'a' }],
        ['attachment-.._.._.._x'],
      ],
      [
        'a shared file name',
        [
          { id: '../../../x', filename: 'map.png', content: 'a' },
          { id: '2', filename: 'map.png', content: 'b' },
        ],
        ['.._.._.._x-map.png', '2-map.png'],
      ],
    ])(
      'keeps an attachment with a hostile id and %s inside attachments/',
      async (_name, attachments, names) => {
        const url = (content: string) =>
          `${JIRA_FAKE_SITE}/rest/api/3/attachment/content/${content}`;
        const { source } = setup({
          issues: [
            {
              key: 'PAWNEE-1',
              summary: 'Park map page',
              attachments: attachments.map((attachment) => ({
                ...attachment,
                content: url(attachment.content),
              })),
            },
          ],
          files: { [url('a')]: 'first', [url('b')]: 'second' },
        });

        const dir = await source.pull('PAWNEE-1');

        expect(fs.readdirSync(dir).sort()).toEqual([
          'attachments',
          'comments.md',
          'description.md',
        ]);
        expect(fs.readdirSync(path.join(dir, 'attachments')).sort()).toEqual(
          [...names].sort()
        );
      }
    );

    it('refuses a comment list Jira cut off rather than write part of it', async () => {
      const comments = ['one', 'two', 'three'].map((word, index) => ({
        id: String(index + 1),
        author: { displayName: 'Ann Perkins' },
        body: doc({
          type: 'paragraph',
          content: [{ type: 'text', text: word }],
        }),
        created: '2026-10-22T10:00:00.000+0000',
      }));
      const { source } = setup({
        issues: [{ key: 'PAWNEE-1', summary: 'Park map page', comments }],
        embeddedComments: 2,
      });

      await expect(source.pull('PAWNEE-1')).rejects.toThrow(
        'Jira has more comments on PAWNEE-1 than Lambda reads in one go, so it stopped rather than work from part of them.'
      );
      await expect(source.get('PAWNEE-1')).rejects.toThrow(
        'Jira has more comments on PAWNEE-1'
      );
    });

    it('keeps two attachments that share a file name', async () => {
      const content = (id: string) =>
        `${JIRA_FAKE_SITE}/rest/api/3/attachment/content/${id}`;
      const { source } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            attachments: [
              { id: '1', filename: 'map.png', content: content('1') },
              { id: '2', filename: 'map.png', content: content('2') },
              { id: '3', filename: 'pins.png', content: content('3') },
            ],
          },
        ],
        files: {
          [content('1')]: 'first map',
          [content('2')]: 'second map',
          [content('3')]: 'pins',
        },
      });

      const dir = path.join(await source.pull('PAWNEE-1'), 'attachments');

      expect(fs.readdirSync(dir).sort()).toEqual([
        '1-map.png',
        '2-map.png',
        'pins.png',
      ]);
      expect(fs.readFileSync(path.join(dir, '1-map.png'), 'utf8')).toBe(
        'first map'
      );
      expect(fs.readFileSync(path.join(dir, '2-map.png'), 'utf8')).toBe(
        'second map'
      );
    });

    it('clears what an earlier pull left behind', async () => {
      const content = `${JIRA_FAKE_SITE}/rest/api/3/attachment/content/1`;
      const { source, fake } = setup({
        issues: [
          {
            key: 'PAWNEE-1',
            summary: 'Park map page',
            attachments: [{ id: '1', filename: 'old.png', content }],
          },
        ],
        files: { [content]: 'old' },
      });
      const dir = await source.pull('PAWNEE-1');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'stale');
      const [issue] = fake.state.issues;

      if (issue === undefined) {
        throw new Error('The fake lost PAWNEE-1.');
      }

      issue.attachments = [];

      await source.pull('PAWNEE-1');

      expect(fs.readdirSync(dir).sort()).toEqual([
        'comments.md',
        'description.md',
      ]);
    });
  });
});

describe('Jira priority and assignee', () => {
  const withAssignees = (options: JiraFakeOptions = {}) =>
    setup(options, {
      config: {
        source: 'jira',
        statuses: JIRA_FAKE_STATUSES,
        site: JIRA_FAKE_SITE,
        project: JIRA_FAKE_PROJECT,
        assignees: { "Leslie's MacBook Pro": 'leslie@pawnee.gov' },
      },
    });

  it("reads Jira's priority names (Lowest as none), and only a mapped assignee", async () => {
    const { source } = withAssignees({
      issues: [
        {
          key: 'PAWNEE-1',
          summary: 'Park map page',
          priority: 'Highest',
          assignee: 'acct-leslie',
        },
        {
          key: 'PAWNEE-2',
          summary: 'Volunteer sign-up form',
          priority: 'Lowest',
          assignee: 'acct-ann',
        },
      ],
    });

    expect(await source.get('PAWNEE-1')).toMatchObject({
      priority: 'urgent',
      assignee: "Leslie's MacBook Pro",
    });
    expect(await source.get('PAWNEE-2')).toMatchObject({
      priority: 'none',
      assignee: null,
    });
  });

  it('writes priority, the assignee (by email), the description and labels', async () => {
    const { source, fake } = withAssignees({
      issues: [{ key: 'PAWNEE-1', summary: 'Park map page', labels: ['bug'] }],
    });

    await source.update('PAWNEE-1', {
      priority: 'high',
      assignee: "Leslie's MacBook Pro",
      description: 'Every park, on one map.',
      removeLabels: ['bug'],
    });

    expect(await source.get('PAWNEE-1')).toMatchObject({
      priority: 'high',
      assignee: "Leslie's MacBook Pro",
      description: 'Every park, on one map.',
      labels: [],
    });
    expect(
      fake.state.requests.find((request) =>
        request.path.endsWith('/PAWNEE-1/assignee')
      )?.body
    ).toEqual({ accountId: 'acct-leslie' });

    await source.update('PAWNEE-1', { assignee: null });

    expect((await source.get('PAWNEE-1')).assignee).toBeNull();
  });

  it('refuses a computer with no Jira user, naming tickets.assignees', async () => {
    const { source } = withAssignees({
      issues: [{ key: 'PAWNEE-1', summary: 'Park map page' }],
    });

    await expect(
      source.update('PAWNEE-1', { assignee: "Ann's Mac mini" })
    ).rejects.toThrow('tickets.assignees');
  });
});
