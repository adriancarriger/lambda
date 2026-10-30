import { type Command } from 'commander';

import { createProgram } from '../../cli';
import { setOwnerName } from './podProject';

/** Parse in-process, capturing what is printed instead of exiting. */
const output = async (args: string[]): Promise<string> => {
  const written: string[] = [];
  const program: Command = createProgram();
  const capture = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({
      writeOut: (text) => {
        written.splice(written.length, 0, text);
      },
      writeErr: (text) => {
        written.splice(written.length, 0, text);
      },
    });
    command.commands.forEach(capture);
  };
  capture(program);

  await program.parseAsync(['node', 'lambda', ...args]).catch(() => undefined);

  return written.join('');
};

const SUBCOMMANDS = [
  'new',
  'list',
  'status',
  'phase',
  'rename',
  'structure',
  'propose-structure',
  'tickets',
  'skip',
  'epic',
  'sync',
  'pause',
  'resume',
  'done',
  'delete',
  'resume-all',
  'send',
  'await',
  'capture',
  'deliver',
  'reply',
  'interrupt',
  'hook',
  'question',
  'resolve',
  'answer',
  'chat',
  'carry-on',
  'nudge',
  'decide',
  'checkpoint',
  'step',
  'request',
  'fork',
  'resolve-conversation',
  // Building pods.
  'build',
  'blocked',
  'skip-ticket',
  'screenshot',
  'pm-chat',
  'talk-ticket',
  'watch-building',
  'peek',
  'ask',
  'relay',
];

const podCommand = (): Command => {
  const pod = createProgram().commands.find(
    (command) => command.name() === 'pod'
  );

  if (pod === undefined) {
    throw new Error('No pod command.');
  }

  return pod;
};

describe('lambda pod --help', () => {
  it('names every subcommand', async () => {
    const help = await output(['pod', '--help']);
    const words = new Set(help.split(/[\s|]+/));

    SUBCOMMANDS.forEach((name) => expect(words).toContain(name));
  });

  it('registers exactly those, so the help never drifts from the commands', () => {
    const registered = podCommand().commands.map((command) => command.name());

    expect(registered.filter((name) => !SUBCOMMANDS.includes(name))).toEqual([
      'render-mode',
    ]);
    SUBCOMMANDS.forEach((name) => expect(registered).toContain(name));
  });

  it('resume-all takes --stagger', async () => {
    const help = await output(['pod', 'resume-all', '--help']);

    expect(help).toContain('--stagger');
  });

  it("names the owner from owner.name in the help an agent reads, else 'the owner'", async () => {
    setOwnerName('Leslie Knope');
    const named = [
      await output(['pod', 'reply', '--help']),
      await output(['pod', 'skip', '--help']),
      await output(['pod', 'request', 'add', '--help']),
      await output(['pod', 'question', 'commit', '--help']),
    ]
      .join('\n')
      .replace(/\s+/g, ' ');

    expect(named).toContain("it goes to Leslie Knope's inbox");
    expect(named).toContain(
      "Leslie Knope's exact words, when an agent relays them"
    );
    expect(named).toContain("Publish a draft to Leslie Knope's inbox");
    expect(named).not.toMatch(/\b[Tt]he owner\b/);

    setOwnerName(undefined);
    expect(
      (await output(['pod', 'skip', '--help'])).replace(/\s+/g, ' ')
    ).toContain("The owner's exact words, when an agent relays them");
  });

  it('lambda --help lists pod and knowledge', async () => {
    const commandLines = (await output(['--help']))
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);

    expect(commandLines).toEqual(expect.arrayContaining(['pod', 'knowledge']));
  });
});
