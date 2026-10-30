import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildingPodStore } from '../../building/__tests__/fakes';
import { registerTicketsCommand } from '../../commands/tickets';
import { registerVerdictCommand } from '../../verdict';
import { verdictsDir } from '../../verdict/store';
import { registerKnowledgeCommand, registerPodCommand } from '../index';
import { buildingSettingsFile, writePodSettings } from '../launch';
import './podProject';

/**
 * The deny lists are the floor when a guard hook doesn't run, so every
 * write subcommand the CLI registers must be on them. A new subcommand
 * fails this until it is either denied or named a read here.
 */

const READS = [
  'pod list',
  'pod status',
  'pod await',
  'pod capture',
  'pod peek',
  'pod ask',
  'pod relay',
  'pod reply',
  'tickets list',
  'tickets next',
  'tickets get',
  'verdict show',
  'knowledge list',
];

/** Every leaf subcommand, as its words after `lambda`. */
const leaves = (command: Command, prefix: string[]): string[][] =>
  command.commands.length === 0
    ? [prefix]
    : command.commands.flatMap((sub) => leaves(sub, [...prefix, sub.name()]));

const registered = (): string[][] => {
  const program = new Command();
  registerPodCommand(program);
  registerTicketsCommand(program);
  registerVerdictCommand(program);
  registerKnowledgeCommand(program);

  return leaves(program, []);
};

/** Denied by its own rule or by a rule for any group above it. */
const denied = (words: string[], deny: string[]): boolean =>
  words.some((_, end) =>
    deny.includes(`Bash(lambda ${words.slice(0, end + 1).join(' ')}:*)`)
  );

const settingsOf = (file: string) => {
  const { store, podId } = buildingPodStore();
  writePodSettings(store, podId, { projectRoot: '/tmp', cli: undefined });

  const settings: { permissions: { allow: string[]; deny: string[] } } =
    JSON.parse(fs.readFileSync(store.file(podId, file), 'utf8'));

  return settings.permissions;
};

describe('the read-only deny lists cover every write subcommand', () => {
  const writes = registered().filter(
    (words) => !READS.includes(words.join(' '))
  );

  it('finds the write subcommands to check', () => {
    expect(writes.map((words) => words.join(' '))).toEqual(
      expect.arrayContaining([
        'pod blocked',
        'pod new',
        'pod checkpoint complete',
        'pod resume-all',
        'pod watch-building',
        'tickets block',
        'tickets unblock',
        'verdict record',
        'knowledge add',
      ])
    );
  });

  it.each(['pm-settings.json', 'ask-settings.json'])(
    '%s denies each of them',
    (file) => {
      const { deny } = settingsOf(file);

      expect(
        writes
          .filter((words) => !denied(words, deny))
          .map((words) => words.join(' '))
      ).toEqual([]);
    }
  );
});

describe("the dev and qa can't grade their own work or run the pod", () => {
  const POD_CONTROL = [
    'Bash(lambda pod blocked:*)',
    'Bash(lambda pod skip-ticket:*)',
    'Bash(lambda pod step:*)',
    'Bash(lambda pod build:*)',
    'Bash(lambda pod done:*)',
    'Bash(lambda stop:*)',
  ];

  it('gives qa its own settings file', () => {
    expect(buildingSettingsFile('qa')).toBe('qa-settings.json');
    expect(buildingSettingsFile('dev')).toBe('settings.json');
  });

  it('denies the dev verdict record and the pod-control commands', () => {
    const { allow, deny } = settingsOf('settings.json');

    expect(deny).toEqual(
      expect.arrayContaining(['Bash(lambda verdict record:*)', ...POD_CONTROL])
    );
    expect(deny).not.toContain('Bash(lambda ship:*)');
    expect(allow.filter((rule) => deny.includes(rule))).toEqual([]);
  });

  it('denies the dev editing or writing the verdicts folder, which the ship gate reads', () => {
    const { deny } = settingsOf('settings.json');
    const dir = verdictsDir('/tmp');

    expect(deny).toContain(`Edit(/${dir}/**)`);
    // Edit covers writing; a Write rule never matches and only warns.
    expect(deny.filter((rule) => rule.startsWith('Write('))).toEqual([]);
  });

  it('lets qa record verdicts, never ship, and denies it the pod-control commands', () => {
    const { allow, deny } = settingsOf('qa-settings.json');

    expect(deny).toEqual(
      expect.arrayContaining(['Bash(lambda ship:*)', ...POD_CONTROL])
    );
    expect(deny).not.toContain('Bash(lambda verdict record:*)');
    expect(allow.filter((rule) => deny.includes(rule))).toEqual([]);
  });
});

describe("a building pod's dev is bound by lambda.json pods.deny", () => {
  it('denies it and drops it from the allow list', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pods-deny-'));
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(make release:*)'] } })
    );
    const { store, podId } = buildingPodStore();

    try {
      writePodSettings(store, podId, {
        projectRoot: root,
        cli: undefined,
        deny: ['Bash(make release:*)'],
      });
      const {
        permissions,
      }: { permissions: { allow: string[]; deny: string[] } } = JSON.parse(
        fs.readFileSync(store.file(podId, 'settings.json'), 'utf8')
      );

      expect(permissions.deny).toContain('Bash(make release:*)');
      expect(permissions.allow).not.toContain('Bash(make release:*)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
