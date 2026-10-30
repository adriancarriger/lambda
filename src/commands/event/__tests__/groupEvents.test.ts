import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { recordEvent } from '..';
import { runCli } from '../../../__tests__/runCli';
import { isKnownType } from '../../../events/schema';
import { createPodStore } from '../../../pod-store';

const project = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-group-events-'))
  );
  fs.writeFileSync(path.join(root, 'lambda.json'), '{}');

  return root;
};

const lines = (root: string): Record<string, unknown>[] => {
  const file = path.join(root, '.lambda', 'events.jsonl');

  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
    : [];
};

const AT = () => '2026-10-23T10:00:00.000Z';

describe('lambda event group.*', () => {
  it('writes the group, ticket, reason and held state as given', () => {
    const root = project();
    recordEvent(root, 'group.add', { group: 'g1', ticket: '3' }, {}, AT);
    recordEvent(
      root,
      'group.reason',
      { group: 'g1', reason: 'Ships when the epic completes, 1 left' },
      {},
      AT
    );
    recordEvent(root, 'group.hold', { group: 'g1', held: true }, {}, AT);

    expect(lines(root)).toEqual([
      { type: 'group.add', groupId: 'g1', ticket: '3', at: AT() },
      {
        type: 'group.reason',
        groupId: 'g1',
        reason: 'Ships when the epic completes, 1 left',
        at: AT(),
      },
      { type: 'group.hold', groupId: 'g1', held: true, at: AT() },
    ]);
    expect(lines(root).every((line) => isKnownType(String(line.type)))).toBe(
      true
    );
  });

  it("leaves a group event inside a pod untagged by the pod's ticket", () => {
    const root = project();
    const store = createPodStore(path.join(root, '.lambda', 'pods'));
    store.writePod({
      id: 'dog-park',
      slug: 'dog-park',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      createdAt: AT(),
      worktreePath: root,
      ownsWorktree: false,
      managerCwd: root,
      devCwd: root,
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    store.appendStep('dog-park', {
      at: AT(),
      step: 'test',
      event: 'start',
      ticket: '3',
      pass: 2,
    });

    recordEvent(
      root,
      'group.hold',
      { group: 'g1', held: true },
      { POD_ID: 'dog-park' },
      AT
    );

    expect(lines(root)).toEqual([
      {
        type: 'group.hold',
        groupId: 'g1',
        held: true,
        pod: 'dog-park',
        at: AT(),
      },
    ]);
  });

  it('refuses a group event without --group, writing nothing', () => {
    const root = project();

    expect(() =>
      recordEvent(root, 'group.add', { ticket: '3' }, {}, AT)
    ).toThrow('--group');
    expect(lines(root)).toEqual([]);
  });
});

describe('lambda event --group --reason --held, from the command line', () => {
  const cwd = process.cwd();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-home-'));

  afterEach(() => {
    process.chdir(cwd);
  });

  it('writes the group, reason and held state the flags give', async () => {
    const root = project();
    process.chdir(root);
    const env = { LAMBDA_HOME: home };

    const add = await runCli(
      ['event', 'group.add', '--group', 'g1', '--ticket', '3'],
      env
    );
    const reason = await runCli(
      [
        'event',
        'group.reason',
        '--group',
        'g1',
        '--reason',
        'Ships when the epic completes, 1 left',
      ],
      env
    );
    const hold = await runCli(
      ['event', 'group.hold', '--group', 'g1', '--held'],
      env
    );

    expect([add.code, reason.code, hold.code]).toEqual([0, 0, 0]);
    expect(
      lines(root).map(({ type, groupId, ticket, reason: why, held }) => ({
        type,
        groupId,
        ticket,
        reason: why,
        held,
      }))
    ).toEqual([
      {
        type: 'group.add',
        groupId: 'g1',
        ticket: '3',
        reason: undefined,
        held: undefined,
      },
      {
        type: 'group.reason',
        groupId: 'g1',
        ticket: undefined,
        reason: 'Ships when the epic completes, 1 left',
        held: undefined,
      },
      {
        type: 'group.hold',
        groupId: 'g1',
        ticket: undefined,
        reason: undefined,
        held: true,
      },
    ]);
  });

  it('refuses a group event without --group, writing nothing', async () => {
    const root = project();
    process.chdir(root);

    const result = await runCli(['event', 'group.add', '--ticket', '3'], {
      LAMBDA_HOME: home,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('group.add needs --group <id>');
    expect(lines(root)).toEqual([]);
  });

  it('refuses a ship event by hand: only lambda ship writes those', async () => {
    const root = project();
    process.chdir(root);

    const result = await runCli(
      ['event', 'ship.end', '--ticket', '3', '--result', 'pass'],
      { LAMBDA_HOME: home }
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain('Only lambda ship records ship.end');
    expect(lines(root)).toEqual([]);
  });
});

describe('lambda event --at', () => {
  it('keeps the time a stage really started and ended', () => {
    const root = project();
    recordEvent(
      root,
      'stage.start',
      { name: 'Build', at: '2026-10-23T09:00:00Z' },
      {},
      AT
    );
    recordEvent(root, 'stage.end', { name: 'Build', result: 'pass' }, {}, AT);

    expect(lines(root).map((line) => line.at)).toEqual([
      '2026-10-23T09:00:00.000Z',
      AT(),
    ]);
  });

  it('takes an ISO time with an offset, written back in UTC', () => {
    const root = project();
    recordEvent(
      root,
      'stage.start',
      { name: 'Build', at: '2026-10-23T04:00:00.500-05:00' },
      {},
      AT
    );

    expect(lines(root).map((line) => line.at)).toEqual([
      '2026-10-23T09:00:00.500Z',
    ]);
  });

  it.each([
    ['not a time', 'is an ISO time'],
    // Times Date.parse reads, in local time: not ISO, so refused.
    ['Oct 23 2026 09:00', 'is an ISO time'],
    ['10/23/2026', 'is an ISO time'],
    ['2026-10-23T09:00:00', 'is an ISO time'],
    ['2026-10-23T11:00:00Z', 'is in the future'],
  ])('refuses --at %s, writing nothing', (at, message) => {
    const root = project();

    expect(() =>
      recordEvent(root, 'stage.start', { name: 'Build', at }, {}, AT)
    ).toThrow(message);
    expect(lines(root)).toEqual([]);
  });
});
