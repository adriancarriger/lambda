import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readKnownAssignees,
  writeKnownAssignees,
} from '../../runner/localFiles';
import {
  buildKnownAssignees,
  mergeAssignees,
  parseIdentities,
  sharedTrackerUsers,
} from '../assignees';
import {
  READ_ONLY_TICKETS,
  createTicketSource,
  withKnownAssignees,
} from '../context';
import { whoAmI } from '../whoAmI';

/** Who each computer is in its tracker, with nothing typed by hand. */

const LESLIE = {
  runnerId: 'rnr_leslie',
  name: 'Leslie’s MacBook Pro',
  identities: [
    {
      tracker: 'linear' as const,
      who: 'leslie-mac@pawnee.gov',
      name: 'Leslie Mac',
    },
  ],
};
const ANN = {
  runnerId: 'rnr_ann',
  name: "Ann's Mac mini",
  identities: [
    {
      tracker: 'linear' as const,
      who: 'ann-mini@pawnee.gov',
      name: 'Ann Mini',
    },
    { tracker: 'jira' as const, who: 'ann@pawnee.gov', name: 'ann@pawnee.gov' },
  ],
};
const OWNER = { name: 'Leslie Knope', email: 'leslie@pawnee.gov' };

describe('the assignee map Lambda hands every computer', () => {
  it("maps each computer's current name, and the owner by the email they signed in with", () => {
    expect(buildKnownAssignees([LESLIE, ANN], OWNER)).toEqual({
      linear: {
        'Leslie’s MacBook Pro': 'leslie-mac@pawnee.gov',
        "Ann's Mac mini": 'ann-mini@pawnee.gov',
        'Leslie Knope': 'leslie@pawnee.gov',
      },
      jira: {
        "Ann's Mac mini": 'ann@pawnee.gov',
        'Leslie Knope': 'leslie@pawnee.gov',
      },
      computers: {
        rnr_leslie: 'Leslie’s MacBook Pro',
        rnr_ann: "Ann's Mac mini",
      },
    });
  });

  it('follows a rename: the same computer, its new name', () => {
    const renamed = { ...ANN, name: 'Ann’s office Mac' };

    expect(buildKnownAssignees([renamed], OWNER).linear).toMatchObject({
      'Ann’s office Mac': 'ann-mini@pawnee.gov',
    });
    expect(buildKnownAssignees([renamed], OWNER).computers).toEqual({
      rnr_ann: 'Ann’s office Mac',
    });
  });

  it('names a tracker user two computers share', () => {
    const sharing = {
      ...ANN,
      identities: [
        {
          tracker: 'linear' as const,
          who: 'Leslie-Mac@pawnee.gov',
          name: null,
        },
      ],
    };

    expect(sharedTrackerUsers([LESLIE, sharing])).toEqual([
      {
        tracker: 'linear',
        who: 'leslie-mac@pawnee.gov',
        computers: ['Leslie’s MacBook Pro', "Ann's Mac mini"],
      },
    ]);
    expect(sharedTrackerUsers([LESLIE, ANN])).toEqual([]);
  });

  it('keeps only well-formed identities from a report', () => {
    expect(
      parseIdentities([
        { tracker: 'linear', who: 'a@pawnee.gov', name: 'A' },
        { tracker: 'trello', who: 'b@pawnee.gov' },
        { tracker: 'jira', who: '' },
        'nonsense',
      ])
    ).toEqual([{ tracker: 'linear', who: 'a@pawnee.gov', name: 'A' }]);
  });
});

describe("a computer's own sources", () => {
  it("puts lambda.json's entries first, then this computer's, then the rest", () => {
    const merged = mergeAssignees(
      { "Ann's Mac mini": 'shared-key@pawnee.gov', Ron: 'ron@pawnee.gov' },
      {
        'Leslie’s MacBook Pro': 'leslie-mac@pawnee.gov',
        'Ann’s Mac mini': 'ann-mini@pawnee.gov',
        'Leslie Knope': 'leslie@pawnee.gov',
      },
      "Leslie's MacBook Pro"
    );

    expect(Object.entries(merged)).toEqual([
      ["Ann's Mac mini", 'shared-key@pawnee.gov'],
      ['Ron', 'ron@pawnee.gov'],
      ['Leslie’s MacBook Pro', 'leslie-mac@pawnee.gov'],
      ['Leslie Knope', 'leslie@pawnee.gov'],
    ]);
  });

  it("reads the map Lambda handed it into every Linear or Jira source's config", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-home-'));
    const env = { LAMBDA_HOME: home };
    fs.writeFileSync(
      path.join(home, 'runner.json'),
      JSON.stringify({ name: "Ann's Mac mini" })
    );
    expect(
      writeKnownAssignees(buildKnownAssignees([LESLIE, ANN], OWNER), env)
    ).toBe(true);
    // The same map again: nothing written.
    expect(
      writeKnownAssignees(buildKnownAssignees([LESLIE, ANN], OWNER), env)
    ).toBe(false);

    const config = withKnownAssignees(
      { source: 'linear', team: 'PAWNEE' },
      env
    );

    expect(Object.keys(config.assignees ?? {})).toEqual([
      "Ann's Mac mini",
      'Leslie’s MacBook Pro',
      'Leslie Knope',
    ]);
    expect(
      withKnownAssignees({ source: 'markdown' }, env).assignees
    ).toBeUndefined();
    expect(
      readKnownAssignees({ LAMBDA_HOME: path.join(home, 'none') })
    ).toEqual({
      linear: {},
      jira: {},
      computers: {},
    });
  });
});

describe('who a computer is in its trackers', () => {
  const linearAnswering = (viewer: unknown, status = 200): typeof fetch =>
    jest.fn(
      async () => new Response(JSON.stringify({ data: { viewer } }), { status })
    );

  it("asks Linear whose its key is, and takes Jira's from its token's email", async () => {
    const found = await whoAmI(
      {
        tokens: {
          linear: 'lin_api_pawnee',
          jira: { email: 'ann@pawnee.gov', apiToken: 'token' },
        },
      },
      {},
      linearAnswering({ name: 'Ann Mini', email: 'ann-mini@pawnee.gov' })
    );

    expect(found).toEqual({
      identities: [
        { tracker: 'linear', who: 'ann-mini@pawnee.gov', name: 'Ann Mini' },
        { tracker: 'jira', who: 'ann@pawnee.gov', name: 'ann@pawnee.gov' },
      ],
      problems: [],
    });
  });

  it('leaves out a key Linear refuses, saying why, and asks nothing without one', async () => {
    const refused = await whoAmI(
      { tokens: { linear: 'lin_api_old' } },
      {},
      linearAnswering(null, 401)
    );

    expect(refused.identities).toEqual([]);
    expect(refused.problems).toEqual(['Linear: Linear answered 401.']);

    const fetchSpy = jest.fn();
    expect(await whoAmI({}, {}, fetchSpy)).toEqual({
      identities: [],
      problems: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a read-only project', () => {
  it('reads its tracker but refuses every write before it gets there', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-ro-'));
    fs.mkdirSync(path.join(root, 'tickets'));
    fs.writeFileSync(
      path.join(root, 'TASKS.md'),
      '# Tasks\n\n- [ ] PAWNEE-1: Park map page\n'
    );
    const source = createTicketSource({
      root,
      config: { source: 'markdown', prefix: 'PAWNEE', readOnly: true },
      tokens: undefined,
      env: { LAMBDA_HOME: root },
      fetch: () => Promise.reject(new Error('No network')),
      runner: null,
    });
    const before = fs.readFileSync(path.join(root, 'TASKS.md'), 'utf8');

    expect(source.readOnly).toBe(true);
    expect((await source.list()).map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
    ]);
    await expect(
      source.update('PAWNEE-1', { status: 'ready' })
    ).rejects.toThrow(READ_ONLY_TICKETS);
    await expect(source.create({ title: 'Lot 48' })).rejects.toThrow(
      READ_ONLY_TICKETS
    );
    await expect(source.comment('PAWNEE-1', 'hi')).rejects.toThrow(
      READ_ONLY_TICKETS
    );
    await expect(source.place(['PAWNEE-1'], 'PAWNEE-1')).rejects.toThrow(
      READ_ONLY_TICKETS
    );
    expect(fs.readFileSync(path.join(root, 'TASKS.md'), 'utf8')).toBe(before);
  });
});
