import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type SourceContext } from '../context';
import { createJiraSource } from '../jira';
import { createLinearSource } from '../linear';
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

/**
 * tickets.lambdaLabel: only the tickets labelled λ (or under an epic that
 * is) are Lambda's. Nothing else is read, everything Lambda makes gets it,
 * and Lambda never shows it as a label.
 */

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-member-')));

const LINEAR_LABELS = [
  { id: 'lb-lambda', name: 'λ' },
  { id: 'lb-bug', name: 'Bug' },
];

const INBOX_STATES = [
  { id: 'st-inbox', name: 'Inbox', type: 'backlog' },
  ...PAWNEE_STATES,
];

const linearSource = (
  fake: { fetch: typeof fetch },
  config: Partial<SourceContext['config']> = {}
) =>
  createLinearSource({
    root: tmp(),
    config: {
      source: 'linear',
      team: 'PAWNEE',
      statuses: PAWNEE_STATUSES,
      lambdaLabel: 'λ',
      ...config,
    },
    tokens: { linear: 'lin_api_test123' },
    env: {},
    fetch: fake.fetch,
    runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
  });

/**
 * PAWNEE-1 (λ, an epic) with PAWNEE-4 under it and PAWNEE-6 under that;
 * PAWNEE-2 (λ and Bug); PAWNEE-3 (Bug only: not Lambda's).
 */
const seededLinear = (options: Parameters<typeof createLinearFake>[0] = {}) => {
  const fake = createLinearFake({ labels: LINEAR_LABELS, ...options });
  const epic = fake.add({
    identifier: 'PAWNEE-1',
    title: 'Park map page',
    sortOrder: 10,
    labelIds: ['lb-lambda'],
  });
  const child = fake.add({
    identifier: 'PAWNEE-4',
    title: 'Map tiles',
    parentId: epic.id,
  });
  fake.add({
    identifier: 'PAWNEE-6',
    title: 'Tile cache',
    parentId: child.id,
  });
  fake.add({
    identifier: 'PAWNEE-2',
    title: 'Volunteer sign-up form',
    sortOrder: 20,
    labelIds: ['lb-lambda', 'lb-bug'],
  });
  fake.add({
    identifier: 'PAWNEE-3',
    title: 'Lot 48 pit photo gallery',
    sortOrder: 30,
    labelIds: ['lb-bug'],
  });

  return fake;
};

describe('Linear: only λ tickets are Lambda’s', () => {
  it('lists the labelled ones and everything under a labelled epic, never the rest', async () => {
    const tickets = await linearSource(seededLinear()).list();

    expect(tickets.map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-4',
      'PAWNEE-6',
      'PAWNEE-2',
    ]);
  });

  it('never shows λ as a label', async () => {
    const tickets = await linearSource(seededLinear()).list();

    expect(tickets.find((t) => t.id === 'PAWNEE-2')?.labels).toEqual(['Bug']);
    expect(tickets.find((t) => t.id === 'PAWNEE-1')?.labels).toEqual([]);
    expect((await linearSource(seededLinear()).get('PAWNEE-2')).labels).toEqual(
      ['Bug']
    );
  });

  it('lists the whole team without a member label', async () => {
    const tickets = await linearSource(seededLinear(), {
      lambdaLabel: undefined,
    }).list();

    expect(tickets.map((ticket) => ticket.id)).toContain('PAWNEE-3');
  });

  it('gives everything it makes the label, in the Inbox', async () => {
    const fake = seededLinear({ states: INBOX_STATES });
    const made = await linearSource(fake, {
      statuses: { ...PAWNEE_STATUSES, inbox: 'Inbox' },
    }).create({ title: 'Harvest festival', labels: ['Bug'] });
    const issue = fake.issues.find((one) => one.identifier === made.id);

    expect(issue?.labelIds.sort()).toEqual(['lb-bug', 'lb-lambda']);
    expect(issue?.stateId).toBe('st-inbox');
    expect(made).toMatchObject({ status: 'inbox', labels: ['Bug'] });
  });

  it("lands a new ticket in Planning's status when the team names no Inbox", async () => {
    const fake = seededLinear();
    const made = await linearSource(fake).create({ title: 'Harvest festival' });

    expect(fake.issues.find((one) => one.identifier === made.id)?.stateId).toBe(
      'st-backlog'
    );
  });

  it('says whether a ticket is still Lambda’s, up through its epics', async () => {
    const fake = seededLinear();
    const tickets = linearSource(fake);

    await expect(tickets.isMember?.('PAWNEE-2')).resolves.toBe(true);
    await expect(tickets.isMember?.('PAWNEE-6')).resolves.toBe(true);
    await expect(tickets.isMember?.('PAWNEE-3')).resolves.toBe(false);

    const two = fake.issues.find((one) => one.identifier === 'PAWNEE-2');

    if (two === undefined) {
      throw new Error('PAWNEE-2 is missing.');
    }

    two.labelIds = ['lb-bug'];

    await expect(tickets.isMember?.('PAWNEE-2')).resolves.toBe(false);
  });

  it('refuses a member label the team doesn’t have, naming the setting', async () => {
    const fake = createLinearFake({ labels: [{ id: 'lb-bug', name: 'Bug' }] });
    fake.add({ identifier: 'PAWNEE-2', title: 'Volunteer sign-up form' });

    await expect(linearSource(fake).list()).rejects.toThrow(
      'Linear team PAWNEE has no label "λ" (tickets.lambdaLabel). Its labels: Bug.'
    );
  });
});

describe('Jira: only λ tickets are Lambda’s', () => {
  const setup = () => {
    const fake = createJiraFake({
      issues: [
        { key: 'PAWNEE-1', summary: 'Park map page', labels: ['λ'] },
        { key: 'PAWNEE-4', summary: 'Map tiles', parent: 'PAWNEE-1' },
        { key: 'PAWNEE-6', summary: 'Tile cache', parent: 'PAWNEE-4' },
        {
          key: 'PAWNEE-2',
          summary: 'Volunteer sign-up form',
          labels: ['λ', 'bug'],
        },
        { key: 'PAWNEE-3', summary: 'Lot 48 pit photos', labels: ['bug'] },
      ],
    });
    const source = createJiraSource({
      root: tmp(),
      config: {
        source: 'jira',
        statuses: JIRA_FAKE_STATUSES,
        site: JIRA_FAKE_SITE,
        project: JIRA_FAKE_PROJECT,
        lambdaLabel: 'λ',
      },
      tokens: {
        jira: { email: 'leslie@pawnee.gov', apiToken: 'jira_token_test123' },
      },
      env: {},
      fetch: fake.fetch,
      runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
    });

    return { fake, source };
  };

  it('lists the labelled ones and everything up to two levels under them, hiding the label', async () => {
    const tickets = await setup().source.list();

    expect(tickets.map((ticket) => ticket.id).sort()).toEqual([
      'PAWNEE-1',
      'PAWNEE-2',
      'PAWNEE-4',
      'PAWNEE-6',
    ]);
    expect(tickets.find((t) => t.id === 'PAWNEE-2')?.labels).toEqual(['bug']);
  });

  it('gives everything it makes the label', async () => {
    const { fake, source } = setup();
    const made = await source.create({ title: 'Harvest festival' });

    expect(
      fake.state.issues.find((issue) => issue.key === made.id)?.labels
    ).toEqual(['λ']);
  });

  it('says whether a ticket is still Lambda’s, up through its epic', async () => {
    const { source } = setup();

    await expect(source.isMember?.('PAWNEE-4')).resolves.toBe(true);
    await expect(source.isMember?.('PAWNEE-6')).resolves.toBe(true);
    await expect(source.isMember?.('PAWNEE-3')).resolves.toBe(false);
  });
});
