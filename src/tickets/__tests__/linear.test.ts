import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type SourceContext } from '../context';
import { createLinearSource } from '../linear';
import { type TicketSource, findNext } from '../source';
import {
  type LinearFake,
  type LinearFakeOptions,
  PAWNEE_STATES,
  PAWNEE_STATUSES,
  createLinearFake,
} from './fakes/linearFake';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-linear-')));

const source = (
  fake: { fetch: typeof fetch },
  overrides: Partial<SourceContext> = {}
): TicketSource =>
  createLinearSource({
    root: tmp(),
    config: {
      source: 'linear',
      team: 'PAWNEE',
      statuses: PAWNEE_STATUSES,
      labels: { planned: 'Planned' },
    },
    tokens: { linear: 'lin_api_test123' },
    env: {},
    fetch: fake.fetch,
    runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
    ...overrides,
  });

/** PAWNEE-1 with children 1a/1b, then PAWNEE-2 and PAWNEE-3. */
const seeded = (options: LinearFakeOptions = {}): LinearFake => {
  const fake = createLinearFake(options);
  const parkMap = fake.add({
    identifier: 'PAWNEE-1',
    title: 'Park map page',
    sortOrder: 10,
  });
  fake.add({
    identifier: 'PAWNEE-3',
    title: 'Lot 48 pit photo gallery',
    sortOrder: 30,
    stateId: 'st-backlog',
    creator: { name: 'Ron Swanson', email: 'ron@pawnee.gov' },
  });
  fake.add({
    identifier: 'PAWNEE-2',
    title: 'Volunteer sign-up form',
    sortOrder: 20,
  });
  fake.add({
    identifier: 'PAWNEE-5',
    title: 'Pins for each park',
    parentId: parkMap.id,
    subIssueSortOrder: 2,
  });
  fake.add({
    identifier: 'PAWNEE-4',
    title: 'Map tiles',
    parentId: parkMap.id,
    subIssueSortOrder: 1,
    stateId: 'st-done',
  });

  return fake;
};

describe('Linear ticket source', () => {
  it('lists in queue order: sortOrder, then each parent’s children by subIssueSortOrder', async () => {
    const tickets = await source(seeded()).list();

    expect(tickets.map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-4',
      'PAWNEE-5',
      'PAWNEE-2',
      'PAWNEE-3',
    ]);
    expect(tickets[0]).toMatchObject({
      title: 'Park map page',
      status: 'ready',
      parent: null,
      children: ['PAWNEE-4', 'PAWNEE-5'],
      blockedBy: [],
      blockReason: null,
      url: 'https://linear.app/pawnee/issue/PAWNEE-1',
    });
    expect(tickets[1]?.status).toBe('done');
    expect(tickets[4]?.status).toBe('planning');
  });

  it('reads the reporter from the issue’s creator', async () => {
    const tickets = await source(seeded()).list();

    expect(tickets.find((t) => t.id === 'PAWNEE-3')?.reporter).toEqual({
      name: 'Ron Swanson',
      email: 'ron@pawnee.gov',
    });
    expect(
      (await source(seeded()).list({ reporter: 'RON@pawnee.gov' })).map(
        (t) => t.id
      )
    ).toEqual(['PAWNEE-3']);
  });

  it('refuses a mapped status the team doesn’t have, listing its states', async () => {
    const fake = createLinearFake({
      states: PAWNEE_STATES.filter((state) => state.name !== 'Todo'),
    });
    fake.add({
      identifier: 'PAWNEE-2',
      title: 'Volunteer sign-up form',
      stateId: 'st-backlog',
    });

    await expect(
      source(fake).update('PAWNEE-2', { status: 'ready' })
    ).rejects.toThrow(
      'Linear team PAWNEE has no status "Todo" (tickets.statuses.ready). Its statuses: Backlog, In Progress, Blocked, Done, Canceled.'
    );
    expect(fake.operations()).not.toContain('LambdaUpdate');
  });

  it('checks the mapped names on the first call of any method: list refuses a missing status', async () => {
    const fake = createLinearFake({
      states: PAWNEE_STATES.filter((state) => state.name !== 'Blocked'),
    });
    fake.add({ identifier: 'PAWNEE-2', title: 'Volunteer sign-up form' });
    const tickets = source(fake);

    await expect(tickets.list()).rejects.toThrow(
      'Linear team PAWNEE has no status "Blocked" (tickets.statuses.blocked). Its statuses: Backlog, Todo, In Progress, Done, Canceled.'
    );
    await expect(tickets.next()).rejects.toThrow('has no status "Blocked"');
    expect(fake.operations()).toEqual(['LambdaTeam']);
  });

  it('a mapped label the team doesn’t have refuses the first call too', async () => {
    const fake = seeded();

    await expect(
      source(fake, {
        config: {
          source: 'linear',
          team: 'PAWNEE',
          statuses: PAWNEE_STATUSES,
          labels: { planned: 'Planed' },
        },
      }).get('PAWNEE-1')
    ).rejects.toThrow(
      'Linear team PAWNEE has no label "Planed" (tickets.labels.planned). Its labels: Planned, Bug.'
    );
  });

  it('reads blockReason back from the latest block marker', async () => {
    const fake = seeded();
    const tickets = source(fake);

    expect((await tickets.get('PAWNEE-2')).blockReason).toBeNull();

    await tickets.update('PAWNEE-2', {
      status: 'blocked',
      reason: 'Ann Perkins is out',
    });
    await tickets.update('PAWNEE-2', {
      status: 'blocked',
      reason: 'Ann Perkins is still out',
    });

    expect(await tickets.get('PAWNEE-2')).toMatchObject({
      status: 'blocked',
      blockReason: 'Ann Perkins is still out',
    });
    expect(
      (await tickets.list()).find((t) => t.id === 'PAWNEE-2')?.blockReason
    ).toBe('Ann Perkins is still out');
    expect(fake.comments.map((c) => c.body)).toEqual([
      'Lambda marked this blocked: Ann Perkins is out',
      'Lambda marked this blocked: Ann Perkins is still out',
    ]);

    await tickets.update('PAWNEE-2', { status: 'ready' });

    expect((await tickets.get('PAWNEE-2')).blockReason).toBeNull();
  });

  it('blocking again with no reason clears the old one; a person’s "Blocked:" comment is never the reason', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.update('PAWNEE-2', {
      status: 'blocked',
      reason: 'Ann Perkins is out',
    });
    await tickets.update('PAWNEE-2', { status: 'ready' });
    await tickets.update('PAWNEE-2', { status: 'blocked' });
    fake.addComment('PAWNEE-2', 'Blocked: the Pawnee Journal is asking');

    expect(fake.comments.map((c) => c.body)).toContain(
      'Lambda marked this blocked.'
    );
    expect((await tickets.get('PAWNEE-2')).blockReason).toBeNull();
    expect(
      (await tickets.list()).find((t) => t.id === 'PAWNEE-2')?.blockReason
    ).toBeNull();
  });

  it('every query stays inside Linear’s complexity limit', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.update('PAWNEE-2', { status: 'blocked', reason: 'Fence' });
    await tickets.list();
    await tickets.get('PAWNEE-2');
    await tickets.pull('PAWNEE-2');

    expect(
      fake.requests
        .filter((request) => request.complexity !== undefined)
        .every((request) => (request.complexity ?? 0) <= 10_000)
    ).toBe(true);
  });

  it('one issue with 150 comments doesn’t stop list or next', async () => {
    const fake = seeded();
    Array.from({ length: 150 }, (_, index) =>
      fake.addComment('PAWNEE-2', `Ben Wyatt: note ${index + 1}`)
    );
    const tickets = source(fake);
    await tickets.update('PAWNEE-2', { status: 'blocked', reason: 'Fence' });

    expect(
      (await tickets.list()).find((t) => t.id === 'PAWNEE-2')?.blockReason
    ).toBe('Fence');
    expect((await tickets.next())?.id).toBe('PAWNEE-5');
  });

  it('a trashed issue isn’t a ticket: get, update, comment and block --by refuse it', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.delete('PAWNEE-3', 'Ann filled in the pit');
    const writes = fake.operations().length;

    await expect(tickets.get('PAWNEE-3')).rejects.toThrow(
      "PAWNEE-3 isn't a ticket I can read."
    );
    await expect(
      tickets.update('PAWNEE-3', { title: 'Lot 48' })
    ).rejects.toThrow("PAWNEE-3 isn't a ticket I can read.");
    await expect(tickets.comment('PAWNEE-3', 'Still here?')).rejects.toThrow(
      "PAWNEE-3 isn't a ticket I can read."
    );
    await expect(tickets.block('PAWNEE-2', 'PAWNEE-3')).rejects.toThrow(
      "PAWNEE-3 isn't a ticket I can read."
    );
    expect(
      fake
        .operations()
        .slice(writes)
        .filter((operation) => operation !== 'LambdaIssue')
    ).toEqual([]);
  });

  it('an issue of another team isn’t a ticket of this codebase', async () => {
    const fake = seeded();
    fake.add({
      identifier: 'EAGLETON-5',
      title: 'Fancy park',
      team: 'EAGLETON',
    });
    const tickets = source(fake);

    await expect(tickets.get('EAGLETON-5')).rejects.toThrow(
      "EAGLETON-5 isn't a ticket I can read."
    );
    await expect(tickets.block('PAWNEE-2', 'EAGLETON-5')).rejects.toThrow(
      "EAGLETON-5 isn't a ticket I can read."
    );
    expect(fake.operations()).not.toContain('LambdaRelate');
  });

  it('a done blocker Linear archived no longer blocks next', async () => {
    const fake = createLinearFake();
    fake.add({ identifier: 'PAWNEE-2', title: 'Volunteer sign-up form' });
    const fence = fake.add({
      identifier: 'PAWNEE-9',
      title: 'Fence the pit',
      stateId: 'st-done',
    });
    const tickets = source(fake);
    await tickets.block('PAWNEE-2', 'PAWNEE-9');
    fence.archivedAt = '2026-10-21T09:00:00.000Z';

    expect((await tickets.list()).map((t) => t.id)).toEqual(['PAWNEE-2']);
    expect((await tickets.next())?.id).toBe('PAWNEE-2');
  });

  it("gives a building pod's queue the archived blocker's status", async () => {
    const fake = createLinearFake();
    fake.add({ identifier: 'PAWNEE-2', title: 'Volunteer sign-up form' });
    const fence = fake.add({
      identifier: 'PAWNEE-9',
      title: 'Fence the pit',
      stateId: 'st-done',
    });
    const tickets = source(fake);
    await tickets.block('PAWNEE-2', 'PAWNEE-9');
    fence.archivedAt = '2026-10-21T09:00:00.000Z';

    const { tickets: queued, outside } = await tickets.queue();

    expect(queued.map((t) => t.id)).toEqual(['PAWNEE-2']);
    expect(outside.get('PAWNEE-9')).toBe('done');
  });

  it('next hands out exactly what the queue would', async () => {
    const fake = createLinearFake();
    fake.add({ identifier: 'PAWNEE-2', title: 'Volunteer sign-up form' });
    fake.add({ identifier: 'PAWNEE-3', title: 'Trail markers' });
    fake.add({ identifier: 'PAWNEE-9', title: 'Fence the pit' });
    const tickets = source(fake);
    await tickets.block('PAWNEE-2', 'PAWNEE-9');

    const { tickets: queued, outside } = await tickets.queue();

    expect((await tickets.next())?.id).toBe(findNext(queued, {}, outside)?.id);
    expect((await tickets.next())?.id).toBe('PAWNEE-3');
  });

  it('a done blocker in another team no longer blocks next', async () => {
    const fake = createLinearFake();
    const form = fake.add({
      identifier: 'PAWNEE-2',
      title: 'Volunteer sign-up form',
    });
    const trailMap = fake.add({
      identifier: 'EAGLETON-3',
      title: 'Shared trail map',
      team: 'EAGLETON',
      stateId: 'st-done',
    });
    fake.relate(trailMap, form);
    const tickets = source(fake);

    expect((await tickets.get('PAWNEE-2')).blockedBy).toEqual(['EAGLETON-3']);
    expect((await tickets.next())?.id).toBe('PAWNEE-2');
  });

  it('an open blocker in another team still blocks next', async () => {
    const fake = createLinearFake();
    const form = fake.add({
      identifier: 'PAWNEE-2',
      title: 'Volunteer sign-up form',
    });
    const trailMap = fake.add({
      identifier: 'EAGLETON-3',
      title: 'Shared trail map',
      team: 'EAGLETON',
      stateId: 'st-progress',
    });
    fake.relate(trailMap, form);

    expect(await source(fake).next()).toBeNull();
  });

  it('list reads every page of issues, in order', async () => {
    const fake = createLinearFake({ issuesPageSize: 2 });
    ['Park map', 'Sign-up', 'Gallery', 'Benches', 'Fountain'].forEach(
      (title, index) =>
        fake.add({
          identifier: `PAWNEE-${index + 1}`,
          title,
          sortOrder: (index + 1) * 10,
        })
    );

    expect((await source(fake).list()).map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-2',
      'PAWNEE-3',
      'PAWNEE-4',
      'PAWNEE-5',
    ]);
    expect(
      fake.requests
        .filter((request) => request.operation === 'LambdaIssues')
        .map((request) => request.variables.after)
    ).toEqual([null, '2', '4']);
  });

  it.each(['AUTHENTICATION_ERROR', 'FORBIDDEN'])(
    'a 400 whose code is %s says Linear refused the key, without the key',
    async (code) => {
      const fake = createLinearFake({
        refuse: {
          status: 400,
          code,
          message: 'Authentication required, not authenticated lin_api_test123',
        },
      });
      const message = await source(fake)
        .list()
        .then(
          () => '',
          (caught: unknown) =>
            caught instanceof Error ? caught.message : String(caught)
        );

      expect(message).toBe('Linear refused the key (400).');
      expect(message).not.toContain('lin_api_test123');
    }
  );

  it('a not-found error on a 400 is an unknown ticket', async () => {
    const fake = createLinearFake({
      refuse: {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Entity not found: Issue',
        operation: 'LambdaIssue',
      },
    });

    await expect(source(fake).get('PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
  });

  it('any other 400 shows the status and Linear’s own message', async () => {
    const fake = createLinearFake({
      refuse: {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Argument Validation Error',
        operation: 'LambdaIssue',
      },
    });

    await expect(source(fake).get('PAWNEE-1')).rejects.toThrow(
      'Linear answered 400: Argument Validation Error'
    );
  });

  it('get reads one issue, without scanning the team', async () => {
    const fake = seeded();
    const ticket = await source(fake).get('PAWNEE-1');

    expect(ticket.children).toEqual(['PAWNEE-4', 'PAWNEE-5']);
    expect(fake.operations()).not.toContain('LambdaIssues');
  });

  it('a 403 says Linear refused the key', async () => {
    const forbidden: typeof fetch = async () =>
      new Response('{}', { status: 403 });

    await expect(source({ fetch: forbidden }).list()).rejects.toThrow(
      'Linear refused the key (403).'
    );
  });

  it('a 500 shows the status and Linear’s own message, with no retry', async () => {
    const sent = { calls: 0 };
    const failing: typeof fetch = async () => {
      sent.calls += 1;

      return new Response(
        '{"errors":[{"message":"Internal server error: try later"}]}',
        { status: 500 }
      );
    };

    await expect(source({ fetch: failing }).list()).rejects.toThrow(
      'Linear answered 500: Internal server error: try later'
    );
    expect(sent.calls).toBe(1);
  });

  it('a blockedBy ticket that no longer exists counts as not done, so next skips it', async () => {
    const fake = seeded();
    const gone = fake.add({ identifier: 'PAWNEE-9', title: 'Pit, filled' });
    const tickets = source(fake);
    await tickets.block('PAWNEE-2', 'PAWNEE-9');
    gone.trashed = true;
    await tickets.update('PAWNEE-1', { status: 'done' });

    expect((await tickets.get('PAWNEE-2')).blockedBy).toEqual(['PAWNEE-9']);
    expect(await tickets.next()).toBeNull();
  });

  it('a 401 says Linear refused the key, without the key', async () => {
    const refusedFetch: typeof fetch = async () =>
      new Response('{"errors":[{"message":"bad key lin_api_test123"}]}', {
        status: 401,
      });
    const message = await source({ fetch: refusedFetch })
      .get('PAWNEE-1')
      .then(
        () => '',
        (caught: unknown) =>
          caught instanceof Error ? caught.message : String(caught)
      );

    expect(message).toBe('Linear refused the key (401).');
    expect(message).not.toContain('lin_api_test123');
  });

  it('LAMBDA_LINEAR_KEY wins over tokens.linear', async () => {
    const fake = seeded();
    await source(fake, { env: { LAMBDA_LINEAR_KEY: 'lin_api_from_env' } }).get(
      'PAWNEE-1'
    );

    expect(fake.requests[0]?.headers.authorization).toBe('lin_api_from_env');
  });

  it('with no key anywhere, refuses before any request', async () => {
    const fake = seeded();

    await expect(source(fake, { tokens: undefined }).list()).rejects.toThrow(
      'No Linear key: set tokens.linear in ~/.lambda/config.json or LAMBDA_LINEAR_KEY.'
    );
    expect(fake.requests).toEqual([]);
  });

  it('an unknown id is not a ticket I can read', async () => {
    await expect(source(seeded()).get('PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
  });

  it('a non-2xx shows the status and Linear’s own message', async () => {
    const brokenFetch: typeof fetch = async () =>
      new Response('{"errors":[{"message":"Rate limited"}]}', {
        status: 429,
      });

    await expect(source({ fetch: brokenFetch }).list()).rejects.toThrow(
      'Linear answered 429: Rate limited'
    );
  });

  it('pull sends the key only to uploads.linear.app, exactly', async () => {
    const fake = createLinearFake({
      files: {
        'https://uploads.linear.app/a.png': 'A',
        'https://uploads.linear.app.evil.test/b.png': 'B',
      },
    });
    fake.add({
      identifier: 'PAWNEE-1',
      title: 'Park map page',
      description:
        'Map:\n\n![a](https://uploads.linear.app/a.png)\n![b](https://uploads.linear.app.evil.test/b.png)\n',
    });
    const root = tmp();
    const dir = await source(fake, { root }).pull('PAWNEE-1');
    const imageRequests = fake.requests.filter(
      (request) => request.operation === undefined
    );

    expect(dir).toBe(path.join(root, '.lambda', 'pulled', 'PAWNEE-1'));
    expect(
      imageRequests.map((request) => [
        request.url,
        request.headers.authorization,
      ])
    ).toEqual([
      ['https://uploads.linear.app/a.png', 'lin_api_test123'],
      ['https://uploads.linear.app.evil.test/b.png', undefined],
    ]);
    expect(fs.readFileSync(path.join(dir, 'description.md'), 'utf8')).toBe(
      'Map:\n\n![a](image-1.png)\n![b](image-2.png)\n'
    );
    expect(fs.readFileSync(path.join(dir, 'image-1.png'), 'utf8')).toBe('A');
  });

  it('pull never sends the key over plain http, even to uploads.linear.app', async () => {
    const fake = createLinearFake({
      files: { 'http://uploads.linear.app/a.png': 'A' },
    });
    fake.add({
      identifier: 'PAWNEE-1',
      title: 'Park map page',
      description: '![a](http://uploads.linear.app/a.png)\n',
    });
    await source(fake).pull('PAWNEE-1');

    expect(
      fake.requests
        .filter((request) => request.operation === undefined)
        .map((request) => [request.url, request.headers.authorization])
    ).toEqual([['http://uploads.linear.app/a.png', undefined]]);
  });

  it('pull refuses an image it can’t download, naming it, rather than skip it', async () => {
    const fake = createLinearFake({
      files: { 'https://uploads.linear.app/b.png': 'B' },
    });
    fake.add({
      identifier: 'PAWNEE-1',
      title: 'Park map page',
      description:
        '![a](https://uploads.linear.app/a.png)\n![b](https://uploads.linear.app/b.png)\n',
    });

    await expect(source(fake).pull('PAWNEE-1')).rejects.toThrow(
      "Couldn't download https://uploads.linear.app/a.png (404). Fix or remove that image in Linear and pull again."
    );
  });

  it('pull gives every image its own name across the description and comments', async () => {
    const fake = createLinearFake({
      files: {
        'https://uploads.linear.app/a.png': 'A',
        'https://uploads.linear.app/b.png': 'B',
        'https://uploads.linear.app/c.png': 'C',
      },
    });
    fake.add({
      identifier: 'PAWNEE-1',
      title: 'Park map page',
      description:
        '![a](https://uploads.linear.app/a.png)\n![b](https://uploads.linear.app/b.png)\n',
    });
    const tickets = source(fake);
    await tickets.comment('PAWNEE-1', '![c](https://uploads.linear.app/c.png)');
    const dir = await tickets.pull('PAWNEE-1');

    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'images.json'), 'utf8'))
    ).toEqual({
      'image-1.png': 'https://uploads.linear.app/a.png',
      'image-2.png': 'https://uploads.linear.app/b.png',
      'image-3.png': 'https://uploads.linear.app/c.png',
    });
    expect(fs.readFileSync(path.join(dir, 'image-2.png'), 'utf8')).toBe('B');
  });

  it.each([
    ['team.labels', "Linear has more team PAWNEE's labels than Lambda reads"],
    ['team.states', "Linear has more team PAWNEE's statuses than Lambda reads"],
    ['issue.labels', 'Linear has more labels on PAWNEE-1 than Lambda reads'],
  ] as const)(
    'refuses a %s list Linear cut off, rather than read part of it',
    async (list, message) => {
      const fake = createLinearFake({ truncated: [list] });
      fake.add({ identifier: 'PAWNEE-1', title: 'Park map page' });

      await expect(source(fake).get('PAWNEE-1')).rejects.toThrow(message);
      expect(fake.operations()).not.toContain('LambdaUpdate');
    }
  );

  it('pull refuses comments Linear cut off, rather than write part of them', async () => {
    const fake = createLinearFake({ truncated: ['issue.comments'] });
    fake.add({ identifier: 'PAWNEE-1', title: 'Park map page' });

    await expect(source(fake).pull('PAWNEE-1')).rejects.toThrow(
      'Linear has more comments on PAWNEE-1 than Lambda reads'
    );
  });

  it('a failed team lookup isn’t kept: the next call asks Linear again', async () => {
    const fake = seeded();
    const calls = { team: 0 };
    const flaky: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? '');

      if (body.includes('LambdaTeam')) {
        calls.team += 1;

        if (calls.team === 1) {
          return new Response('{"errors":[{"message":"try later"}]}', {
            status: 500,
          });
        }
      }

      return fake.fetch(input, init);
    };
    const tickets = source({ fetch: flaky });

    await expect(tickets.list()).rejects.toThrow('Linear answered 500');
    expect((await tickets.list()).map((t) => t.id)).toContain('PAWNEE-1');
    expect(calls.team).toBe(2);
  });

  it('pull writes comments; push sends the edited description back with the image URLs restored', async () => {
    const fake = createLinearFake({
      files: { 'https://uploads.linear.app/a.png': 'A' },
    });
    fake.add({
      identifier: 'PAWNEE-1',
      title: 'Park map page',
      description: 'Tiles.\n![a](https://uploads.linear.app/a.png)\n',
    });
    const root = tmp();
    const tickets = source(fake, { root });
    await tickets.comment('PAWNEE-1', 'Ben Wyatt: tiles are in, pins next.');
    const dir = await tickets.pull('PAWNEE-1');

    expect(fs.readFileSync(path.join(dir, 'comments.md'), 'utf8')).toContain(
      'Ben Wyatt: tiles are in, pins next.'
    );

    fs.writeFileSync(
      path.join(dir, 'description.md'),
      'Tiles and pins.\n![a](image-1.png)\n'
    );
    // `push` is a closure; called bare because the lint rule flags `.push(`.
    const { push } = tickets;
    await push('PAWNEE-1');

    expect(fake.issues[0]?.description).toBe(
      'Tiles and pins.\n![a](https://uploads.linear.app/a.png)\n'
    );
  });

  it('create: the description, a parent, status planning by default', async () => {
    const fake = seeded();
    const tickets = source(fake);
    const lot = await tickets.create({
      title: 'Lot 48',
      description: 'Fill the pit.',
    });
    const pins = await tickets.create({
      title: 'Fill the pit',
      parent: 'PAWNEE-3',
      status: 'ready',
    });

    expect(lot).toMatchObject({ id: 'PAWNEE-6', status: 'planning' });
    expect((await tickets.get('PAWNEE-6')).description).toBe('Fill the pit.');
    expect(pins).toMatchObject({
      id: 'PAWNEE-7',
      parent: 'PAWNEE-3',
      status: 'ready',
    });
    expect((await tickets.get('PAWNEE-3')).children).toEqual(['PAWNEE-7']);
  });

  it('update: status, title and an added label by the project’s names', async () => {
    const fake = seeded();
    const updated = await source(fake).update('PAWNEE-2', {
      status: 'building',
      title: 'Volunteer sign-up',
      labels: ['planned', 'Bug'],
    });

    expect(updated).toMatchObject({
      status: 'building',
      title: 'Volunteer sign-up',
      labels: ['planned', 'Bug'],
    });
    expect(
      fake.requests.find((r) => r.operation === 'LambdaUpdate')?.variables
    ).toEqual({
      id: 'uuid-PAWNEE-2',
      input: {
        stateId: 'st-progress',
        title: 'Volunteer sign-up',
        labelIds: ['lb-planned', 'lb-bug'],
      },
    });
  });

  it('refuses a label the team doesn’t have, listing its labels', async () => {
    await expect(
      source(seeded()).update('PAWNEE-2', { labels: ['urgent'] })
    ).rejects.toThrow(
      'Linear team PAWNEE has no label "urgent". Its labels: Planned, Bug.'
    );
  });

  it('block and unblock write and remove a "blocks" relation; next skips the blocked ticket', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.update('PAWNEE-4', { status: 'ready' });
    await tickets.block('PAWNEE-1', 'PAWNEE-3');

    expect(
      fake.requests.find((r) => r.operation === 'LambdaRelate')?.variables
    ).toEqual({ blocker: 'uuid-PAWNEE-3', blocked: 'uuid-PAWNEE-1' });
    expect((await tickets.get('PAWNEE-1')).blockedBy).toEqual(['PAWNEE-3']);
    expect((await tickets.next())?.id).toBe('PAWNEE-2');

    await tickets.unblock('PAWNEE-1', 'PAWNEE-3');

    expect(fake.operations()).toContain('LambdaUnrelate');
    expect((await tickets.get('PAWNEE-1')).blockedBy).toEqual([]);
    expect((await tickets.next())?.id).toBe('PAWNEE-4');
  });

  it('block by an unknown ticket writes nothing', async () => {
    const fake = seeded();

    await expect(source(fake).block('PAWNEE-2', 'PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
    expect(fake.operations()).not.toContain('LambdaRelate');
  });

  it('reorder writes subIssueSortOrder, and refuses ids that aren’t exactly the children', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.reorder('PAWNEE-1', ['PAWNEE-5', 'PAWNEE-4']);

    expect((await tickets.get('PAWNEE-1')).children).toEqual([
      'PAWNEE-5',
      'PAWNEE-4',
    ]);
    await expect(
      tickets.reorder('PAWNEE-1', ['PAWNEE-5', 'PAWNEE-2'])
    ).rejects.toThrow(/missing PAWNEE-4; not its children: PAWNEE-2/);
  });

  it('place moves top-level tickets right after another, by sortOrder', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.place(['PAWNEE-3'], 'PAWNEE-1');

    expect(
      (await tickets.list()).filter((t) => t.parent === null).map((t) => t.id)
    ).toEqual(['PAWNEE-1', 'PAWNEE-3', 'PAWNEE-2']);
    await expect(tickets.place(['PAWNEE-3'], 'PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
  });

  it('delete refuses a ticket with children, and trashes a child before posting the reason on its parent', async () => {
    const fake = seeded();
    const tickets = source(fake);

    await expect(tickets.delete('PAWNEE-1', 'Merged')).rejects.toThrow(
      'PAWNEE-1 still has children: PAWNEE-4, PAWNEE-5.'
    );
    await tickets.delete('PAWNEE-5', 'Merged into PAWNEE-4');

    expect(fake.comments.map((c) => c.body)).toEqual([
      'Deleted PAWNEE-5 ("Pins for each park"): Merged into PAWNEE-4',
    ]);
    expect((await tickets.list()).map((t) => t.id)).not.toContain('PAWNEE-5');
    const writes = fake
      .operations()
      .filter((operation) =>
        ['LambdaUpdate', 'LambdaTrash', 'LambdaComment'].includes(operation)
      );
    expect(writes.indexOf('LambdaTrash')).toBeLessThan(
      writes.indexOf('LambdaComment')
    );
  });

  it('delete restores the parent’s status after Linear closes it for its last open child', async () => {
    const fake = seeded();
    await source(fake).delete('PAWNEE-5', 'Merged into PAWNEE-4');

    expect(
      fake.requests
        .filter((request) => request.operation === 'LambdaUpdate')
        .map((request) => request.variables)
    ).toContainEqual({
      id: 'uuid-PAWNEE-1',
      input: { stateId: 'st-todo' },
    });
    expect(fake.issues.find((i) => i.identifier === 'PAWNEE-1')?.stateId).toBe(
      'st-todo'
    );
  });

  it('a refused trash posts no comment and leaves the child under its parent', async () => {
    const fake = seeded({
      refuse: {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Issue is locked',
        operation: 'LambdaTrash',
      },
    });
    const tickets = source(fake);

    await expect(
      tickets.delete('PAWNEE-5', 'Merged into PAWNEE-4')
    ).rejects.toThrow('Linear answered 400: Issue is locked');
    expect(fake.comments).toEqual([]);
    expect((await tickets.get('PAWNEE-5')).parent).toBe('PAWNEE-1');
    expect((await tickets.get('PAWNEE-1')).children).toEqual([
      'PAWNEE-4',
      'PAWNEE-5',
    ]);
  });

  it('a refused trash whose put-back is refused too names both failures', async () => {
    const fake = seeded();
    const refused = (message: string): Response =>
      new Response(
        JSON.stringify({
          errors: [{ message, extensions: { code: 'INVALID_INPUT' } }],
        }),
        { status: 400 }
      );
    const failing: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? '');

      if (body.includes('LambdaTrash')) {
        return refused('Issue is locked');
      }

      if (body.includes('LambdaUpdate') && body.includes('"parentId":"uuid-')) {
        return refused('Parent is archived');
      }

      return fake.fetch(input, init);
    };

    const message = await source({ fetch: failing })
      .delete('PAWNEE-5', 'Merged into PAWNEE-4')
      .then(
        () => '',
        (caught: unknown) =>
          caught instanceof Error ? caught.message : String(caught)
      );

    expect(message).toContain('Linear answered 400: Issue is locked');
    expect(message).toContain('Linear answered 400: Parent is archived');
    expect(message).toContain('PAWNEE-5');
    expect(fake.comments).toEqual([]);
  });

  it('place moves a parent’s children among themselves, by subIssueSortOrder', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.place(['PAWNEE-4'], 'PAWNEE-5');

    expect((await tickets.get('PAWNEE-1')).children).toEqual([
      'PAWNEE-5',
      'PAWNEE-4',
    ]);
    expect(
      fake.requests
        .filter((request) => request.operation === 'LambdaUpdate')
        .map((request) => Object.keys(Object(request.variables.input)))
    ).toEqual([['subIssueSortOrder']]);
  });

  it('place refuses tickets that aren’t at the anchor’s level, writing nothing', async () => {
    const fake = seeded();

    await expect(source(fake).place(['PAWNEE-4'], 'PAWNEE-2')).rejects.toThrow(
      "PAWNEE-4 and PAWNEE-2 aren't at the same level: place moves tickets among their siblings."
    );
    expect(fake.operations()).not.toContain('LambdaUpdate');
  });

  it('push refuses a linked picture missing from the pulled folder, writing nothing', async () => {
    const fake = createLinearFake();
    fake.add({ identifier: 'PAWNEE-1', title: 'Park map page' });
    const tickets = source(fake);
    const dir = await tickets.pull('PAWNEE-1');
    fs.writeFileSync(
      path.join(dir, 'description.md'),
      'Pins.\n![pin](pin.png)\n'
    );
    const { push } = tickets;

    await expect(push('PAWNEE-1')).rejects.toThrow(
      `Can't push PAWNEE-1: pin.png isn't in ${dir}. Put the file there, or remove the link.`
    );
    expect(fake.operations()).not.toContain('LambdaUpdate');
    expect(fake.operations()).not.toContain('LambdaFileUpload');
  });

  it('unblock by a blocker since trashed takes the block off, so next runs the ticket', async () => {
    const fake = createLinearFake();
    fake.add({ identifier: 'PAWNEE-2', title: 'Volunteer sign-up form' });
    const gone = fake.add({ identifier: 'PAWNEE-9', title: 'Pit, filled' });
    const tickets = source(fake);
    await tickets.block('PAWNEE-2', 'PAWNEE-9');
    gone.trashed = true;

    expect(await tickets.next()).toBeNull();

    await tickets.unblock('PAWNEE-2', 'PAWNEE-9');

    expect((await tickets.get('PAWNEE-2')).blockedBy).toEqual([]);
    expect((await tickets.next())?.id).toBe('PAWNEE-2');
  });

  it('unblock by another team’s blocker takes the block off, so next runs the ticket', async () => {
    const fake = createLinearFake();
    const form = fake.add({
      identifier: 'PAWNEE-2',
      title: 'Volunteer sign-up form',
    });
    const trailMap = fake.add({
      identifier: 'EAGLETON-3',
      title: 'Shared trail map',
      team: 'EAGLETON',
      stateId: 'st-progress',
    });
    fake.relate(trailMap, form);
    const tickets = source(fake);

    expect(await tickets.next()).toBeNull();

    await tickets.unblock('PAWNEE-2', 'EAGLETON-3');

    expect((await tickets.next())?.id).toBe('PAWNEE-2');
  });

  it('an issue with more relations than Linear sends at once is read whole: a block past the first page still counts', async () => {
    const fake = createLinearFake();
    const form = fake.add({
      identifier: 'PAWNEE-2',
      title: 'Volunteer sign-up form',
    });
    Array.from({ length: 25 }, (_, index) =>
      fake.relate(
        fake.add({
          identifier: `PAWNEE-${index + 10}`,
          title: `Related ${index + 1}`,
          stateId: 'st-backlog',
        }),
        form,
        'related'
      )
    );
    const fence = fake.add({
      identifier: 'PAWNEE-9',
      title: 'Fence the pit',
      stateId: 'st-progress',
    });
    fake.relate(fence, form);
    const tickets = source(fake);

    expect(
      (await tickets.list()).find((t) => t.id === 'PAWNEE-2')?.blockedBy
    ).toEqual(['PAWNEE-9']);
    expect((await tickets.get('PAWNEE-2')).blockedBy).toEqual(['PAWNEE-9']);
    expect(await tickets.next()).toBeNull();

    fence.stateId = 'st-done';

    expect((await tickets.next())?.id).toBe('PAWNEE-2');
  });

  it('next, reorder and place never read a block reason; list and get do', async () => {
    const fake = seeded();
    const tickets = source(fake);
    await tickets.update('PAWNEE-2', { status: 'blocked', reason: 'Fence' });
    await tickets.update('PAWNEE-3', { status: 'blocked' });
    const reasonReads = (): number =>
      fake
        .operations()
        .filter((operation) => operation === 'LambdaBlockMarkers').length;
    const before = reasonReads();

    await tickets.next();
    await tickets.reorder('PAWNEE-1', ['PAWNEE-5', 'PAWNEE-4']);
    await tickets.place(['PAWNEE-3'], 'PAWNEE-1');

    expect(reasonReads()).toBe(before);

    await tickets.list();

    expect(reasonReads()).toBe(before + 2);

    await tickets.get('PAWNEE-2');

    expect(reasonReads()).toBe(before + 3);
  });

  it('refuses an id that isn’t safe for a path or a request', async () => {
    const fake = seeded();

    await expect(source(fake).get('../evil')).rejects.toThrow(
      '"../evil" isn\'t a ticket id'
    );
    expect(fake.requests).toEqual([]);
  });
});

describe('Linear priority and assignee', () => {
  const assignees = {
    "Leslie's MacBook Pro": 'leslie@pawnee.gov',
  };
  const withAssignees = (fake: LinearFake): TicketSource =>
    source(fake, {
      config: {
        source: 'linear',
        team: 'PAWNEE',
        statuses: PAWNEE_STATUSES,
        assignees,
      },
    });

  it("reads Linear's priority, and an assignee only when it stands for a computer", async () => {
    const fake = seeded();
    fake.add({
      identifier: 'PAWNEE-6',
      title: 'Harvest festival schedule',
      priority: 2,
      assigneeId: 'user-leslie',
    });
    fake.add({
      identifier: 'PAWNEE-7',
      title: 'Raccoon report form',
      priority: 1,
      assigneeId: 'user-ann',
    });

    const tickets = await withAssignees(fake).list();
    const byId = (id: string) => tickets.find((ticket) => ticket.id === id);

    expect(byId('PAWNEE-6')).toMatchObject({
      priority: 'high',
      assignee: "Leslie's MacBook Pro",
    });
    // Ann is a person, not a computer: unassigned as far as Lambda goes.
    expect(byId('PAWNEE-7')).toMatchObject({
      priority: 'urgent',
      assignee: null,
    });
    expect(byId('PAWNEE-2')).toMatchObject({
      priority: 'none',
      assignee: null,
    });
  });

  it('writes priority, the mapped user, the description and labels', async () => {
    const fake = seeded();
    const linear = withAssignees(fake);

    await linear.update('PAWNEE-2', {
      priority: 'medium',
      assignee: "Leslie's MacBook Pro",
      description: 'Sign-ups close a week before.',
      labels: ['Bug'],
    });

    expect(await linear.get('PAWNEE-2')).toMatchObject({
      priority: 'medium',
      assignee: "Leslie's MacBook Pro",
      description: 'Sign-ups close a week before.',
      labels: ['Bug'],
    });

    await linear.update('PAWNEE-2', { assignee: null, removeLabels: ['Bug'] });

    expect(await linear.get('PAWNEE-2')).toMatchObject({
      assignee: null,
      labels: [],
    });
  });

  it("matches a computer's name however its apostrophe is typed", async () => {
    const fake = seeded();
    fake.add({
      identifier: 'PAWNEE-6',
      title: 'Harvest festival schedule',
      assigneeId: 'user-leslie',
    });
    // macOS names it with a curly apostrophe; lambda.json is typed straight.
    const linear = source(fake, {
      config: {
        source: 'linear',
        team: 'PAWNEE',
        statuses: PAWNEE_STATUSES,
        assignees: { 'Leslie\u2019s MacBook Pro': 'leslie@pawnee.gov' },
      },
    });

    await linear.update('PAWNEE-2', { assignee: "Leslie's MacBook Pro" });

    expect(await linear.get('PAWNEE-2')).toMatchObject({
      assignee: 'Leslie\u2019s MacBook Pro',
    });
  });

  it("names the tracker's own state when Lambda reads it as another", async () => {
    const fake = seeded();
    fake.add({
      identifier: 'PAWNEE-6',
      title: 'Harvest festival schedule',
      stateId: 'st-progress',
    });
    // No building state named: "In Progress" is read as building by its type.
    const { building: _unnamed, ...statuses } = PAWNEE_STATUSES;
    const tickets = await source(fake, {
      config: { source: 'linear', team: 'PAWNEE', statuses },
    }).list();
    const byId = (id: string) => tickets.find((ticket) => ticket.id === id);

    expect(byId('PAWNEE-6')).toMatchObject({
      status: 'building',
      trackerStatus: 'In Progress',
    });
    // Todo is ready's own name: nothing more to say.
    expect(byId('PAWNEE-2')?.trackerStatus).toBeNull();
  });

  it('refuses a computer with no Linear user, naming tickets.assignees', async () => {
    await expect(
      withAssignees(seeded()).update('PAWNEE-2', { assignee: "Ann's Mac mini" })
    ).rejects.toThrow('tickets.assignees');
  });

  it('creates with priority and assignee', async () => {
    const linear = withAssignees(seeded());
    const created = await linear.create({
      title: 'Contact page',
      priority: 'low',
      assignee: "Leslie's MacBook Pro",
    });

    expect(created).toMatchObject({
      priority: 'low',
      assignee: "Leslie's MacBook Pro",
    });
  });
});
