import * as fs from 'fs';
import * as path from 'path';

import {
  changesProblems,
  insteadProblems,
  understoodProblems,
} from '../decisions';
import { buildResolution } from '../resolution';
import { PodSchema } from '../schemas';

const decision = {
  id: 'hd1',
  podId: 'pawnee-a1b2',
  qid: 'q3',
  decision: 'Keep the budget line',
  quote: 'keep it, Ron will cope',
  createdAt: '2026-10-20T00:00:00.000Z',
};

// An older pod's stored name for its owner.
const OLD_OWNER = 'adrian';

const resolve = (ownerName?: string): string =>
  buildResolution({
    ownerName,
    qid: 'q3',
    msgId: 'm1',
    unconfirmed: false,
    decisions: [decision],
    conversation: [],
  });

describe('the owner is named from the machine settings', () => {
  it('names the owner on the decided line', () => {
    const text = resolve('Leslie Knope');

    expect(text).toContain('   Leslie Knope: "keep it, Ron will cope"');
    expect(text.toLowerCase()).not.toContain(OLD_OWNER);
  });

  it('says Owner when there is no name', () => {
    const text = resolve();

    expect(text).toContain('   Owner: "keep it, Ron will cope"');
    expect(text.toLowerCase()).not.toContain(OLD_OWNER);
  });
});

describe('decision checks name the owner', () => {
  const checks: [string, (ownerName?: string) => string][] = [
    ['--instead', (ownerName) => insteadProblems('', ownerName).join('\n')],
    [
      '--understood',
      (ownerName) => understoodProblems('', ownerName).join('\n'),
    ],
    [
      'a change without "before"',
      (ownerName) =>
        changesProblems(
          [
            {
              kind: 'screen',
              text: 'The parks map shows trails',
              why: 'Ron asked for it',
            },
          ],
          ownerName
        ).join('\n'),
    ],
  ];

  it.each(checks)('%s uses the name from the machine settings', (_, check) => {
    const text = check('Leslie Knope');

    expect(text).toContain('Leslie Knope');
    expect(text).not.toContain('the owner');
    expect(text.toLowerCase()).not.toContain(OLD_OWNER);
  });

  it.each(checks)('%s says Owner when there is no name', (_, check) => {
    expect(check()).toContain('Owner');
  });

  it('the --understood check names the owner twice, never a pronoun', () => {
    expect(understoodProblems('', 'Leslie Knope')[0]).toBe(
      'The UX review needs --understood "<2–3 sentences>": what you understood Leslie Knope wants, from intent.md — this is where Leslie Knope catches a misread.'
    );
  });
});

describe('titleBy', () => {
  const pod = {
    id: 'pawnee-a1b2',
    slug: 'harvest-festival',
    createdAt: '2026-10-20T00:00:00.000Z',
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee-a1b2',
    ownsWorktree: true,
    managerCwd: '/tmp/pawnee-a1b2',
    devCwd: '/tmp/pawnee-a1b2',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  };

  it.each([
    [OLD_OWNER, 'owner'],
    ['bob', 'owner'],
    ['agent', 'agent'],
  ])('reads a stored %s as %s', (stored, expected) => {
    expect(PodSchema.parse({ ...pod, titleBy: stored }).titleBy).toBe(expected);
  });

  it('leaves an absent titleBy absent', () => {
    expect(PodSchema.parse(pod).titleBy).toBeUndefined();
  });
});

describe('pod-store text rules', () => {
  const root = path.resolve(__dirname, '..');
  const files = fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  const rules: { rule: string; match: RegExp }[] = [
    {
      rule: 'a guessed pronoun',
      match: /\b(he|his|him|himself|she|her|hers|herself)\b/i,
    },
    { rule: 'a Linear title', match: /Linear title/ },
  ];

  it.each(rules)('no non-test file has $rule', ({ match }) => {
    const hits = files.flatMap((name) =>
      fs
        .readFileSync(path.join(root, name), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          match.test(line) ? [`${name}:${index + 1}: ${line.trim()}`] : []
        )
    );

    expect(hits).toEqual([]);
  });
});
