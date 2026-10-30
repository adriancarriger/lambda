/**
 * `lambda tickets push` attaches the pictures a pulled description links
 * inside its own folder, and nothing else: a pulled description is text
 * anyone with access to the ticket can write, so a link out of the folder
 * (by `..`, an absolute path or a symlink) or to another kind of file is
 * left as written and named, never uploaded. Then `lambda tickets attach`
 * and `comment --image` on the command line.
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type TicketsDeps,
  registerTicketsCommand,
} from '../../commands/tickets';
import { ProjectConfigSchema } from '../../config/projectConfig';
import { type SourceContext, createTicketSource, pulledDir } from '../context';
import { type TicketSource, rewriteImageLinks } from '../source';
import {
  JIRA_FAKE_PROJECT,
  JIRA_FAKE_SITE,
  JIRA_FAKE_STATUSES,
  createJiraFake,
} from './fakes/jiraFake';
import { PAWNEE_STATUSES, createLinearFake } from './fakes/linearFake';

const tmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const context = (overrides: Partial<SourceContext>): SourceContext => ({
  root: tmp('lambda-push-images-'),
  config: { source: 'markdown', prefix: 'PAWNEE' },
  tokens: undefined,
  env: {},
  fetch: async () => {
    throw new Error('No network call expected.');
  },
  runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
  ...overrides,
});

const linear = () => {
  const fake = createLinearFake();
  fake.add({
    identifier: 'PAWNEE-5',
    title: 'Volunteer sign-up form',
    description: 'The form.\n',
  });
  const opened = context({
    config: {
      source: 'linear',
      statuses: PAWNEE_STATUSES,
      team: 'PAWNEE',
      prefix: 'PAWNEE',
    },
    tokens: { linear: 'lin_api_test' },
    fetch: fake.fetch,
  });

  return { fake, root: opened.root, source: createTicketSource(opened) };
};

/** Pull, then write the description (and any files) into the pulled folder. */
const edited = async (
  source: TicketSource,
  root: string,
  description: string,
  files: Record<string, string> = {}
): Promise<string> => {
  await source.pull('PAWNEE-5');
  const dir = pulledDir(root, 'PAWNEE-5');
  fs.writeFileSync(path.join(dir, 'description.md'), description);
  Object.entries(files).forEach(([name, text]) =>
    fs.writeFileSync(path.join(dir, name), text)
  );

  return dir;
};

describe('push attaches the pictures in the pulled folder', () => {
  it('Linear: trail.png is uploaded once and its link rewritten to the asset URL', async () => {
    const { fake, root, source } = linear();
    await edited(
      source,
      root,
      'Trail map.\n![trail](trail.png)\n\nAgain: ![trail](trail.png)\n',
      { 'trail.png': 'the trail map' }
    );
    // `push` is a closure; called bare because the lint rule flags `.push(`.
    const { push } = source;
    const said = await push('PAWNEE-5');
    const asset = 'https://uploads.linear.app/pawnee/1/trail.png';

    expect(fake.uploads.map((upload) => upload.filename)).toEqual([
      'trail.png',
    ]);
    expect(fake.issues[0]?.description).toBe(
      `Trail map.\n![trail](${asset})\n\nAgain: ![trail](${asset})\n`
    );
    expect(said).toContain('trail.png');
  });

  it('Linear: a linked picture missing from the folder refuses the push, naming it, with nothing sent', async () => {
    const { fake, root, source } = linear();
    await edited(source, root, 'Trail map.\n![trail](trail.png)\n');
    const before = fake.operations().length;
    const { push } = source;

    await expect(push('PAWNEE-5')).rejects.toThrow('trail.png');
    expect(fake.operations().slice(before)).not.toContain('LambdaFileUpload');
    expect(fake.operations()).not.toContain('LambdaUpdate');
    expect(fake.uploads).toEqual([]);
  });

  it('Linear: links out of the folder, or to other files, are never uploaded: left as written and named', async () => {
    const { fake, root, source } = linear();
    const outside = tmp('lambda-push-outside-');
    fs.writeFileSync(path.join(outside, 'keys.png'), 'not for Linear');
    const dir = pulledDir(root, 'PAWNEE-5');
    const links = [
      '![trail](trail.png)',
      '![secret](../../secret.png)',
      `![keys](${path.join(outside, 'keys.png')})`,
      '![notes](notes.txt)',
      '![out](out.png)',
    ];
    await edited(source, root, `${links.join('\n')}\n`, {
      'trail.png': 'the trail map',
      'notes.txt': 'Ron hates this',
    });
    fs.mkdirSync(path.join(root, '.lambda'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lambda', 'secret.png'), 'secret');
    fs.symlinkSync(path.join(outside, 'keys.png'), path.join(dir, 'out.png'));
    const { push } = source;
    const said = await push('PAWNEE-5');

    expect(fake.uploads.map((upload) => upload.filename)).toEqual([
      'trail.png',
    ]);
    expect(fake.issues[0]?.description).toBe(
      [
        '![trail](https://uploads.linear.app/pawnee/1/trail.png)',
        ...links.slice(1),
        '',
      ].join('\n')
    );
    [
      '../../secret.png',
      path.join(outside, 'keys.png'),
      'notes.txt',
      'out.png',
    ].forEach((name) => expect(said).toContain(name));
  });

  it('Jira: trail.png is attached to the issue and linked as a text link, never a media node', async () => {
    const fake = createJiraFake({
      issues: [{ key: 'PAWNEE-5', summary: 'Volunteer sign-up form' }],
    });
    const opened = context({
      config: {
        source: 'jira',
        statuses: JIRA_FAKE_STATUSES,
        site: JIRA_FAKE_SITE,
        project: JIRA_FAKE_PROJECT,
        prefix: 'PAWNEE',
      },
      tokens: { jira: { email: 'leslie@pawnee.gov', apiToken: 'jira-test' } },
      fetch: fake.fetch,
    });
    const source = createTicketSource(opened);
    await edited(source, opened.root, 'Trail map: ![trail](trail.png)\n', {
      'trail.png': 'the trail map',
    });
    const { push } = source;
    await push('PAWNEE-5');
    const [issue] = fake.state.issues;
    const content = `${JIRA_FAKE_SITE}/rest/api/3/attachment/content/${
      issue?.attachments[0]?.id ?? '?'
    }`;

    expect(issue?.attachments.map((one) => one.filename)).toEqual([
      'trail.png',
    ]);
    expect(issue?.description).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Trail map: ' },
            {
              type: 'text',
              text: 'trail',
              marks: [{ type: 'link', attrs: { href: content } }],
            },
          ],
        },
      ],
    });
  });

  it('Jira: a missing linked picture refuses the push with nothing sent', async () => {
    const fake = createJiraFake({
      issues: [{ key: 'PAWNEE-5', summary: 'Volunteer sign-up form' }],
    });
    const opened = context({
      config: {
        source: 'jira',
        statuses: JIRA_FAKE_STATUSES,
        site: JIRA_FAKE_SITE,
        project: JIRA_FAKE_PROJECT,
        prefix: 'PAWNEE',
      },
      tokens: { jira: { email: 'leslie@pawnee.gov', apiToken: 'jira-test' } },
      fetch: fake.fetch,
    });
    const source = createTicketSource(opened);
    await edited(source, opened.root, '![trail](trail.png)\n');
    const { push } = source;

    await expect(push('PAWNEE-5')).rejects.toThrow('trail.png');
    expect(fake.writes()).toEqual([]);
  });
});

// ── the command line ────────────────────────────────────────────────────────

const cli = () => {
  const root = tmp('lambda-attach-cli-');
  fs.writeFileSync(
    path.join(root, 'TASKS.md'),
    '- [ ] PAWNEE-5: Volunteer sign-up form\n'
  );
  const config = ProjectConfigSchema.parse({
    name: 'Pawnee Parks app',
    tickets: { source: 'markdown', prefix: 'PAWNEE' },
  });
  const printed: string[] = [];
  const deps: TicketsDeps = {
    project: { root, file: path.join(root, 'lambda.json'), config },
    machine: { owner: { name: 'Leslie' } },
    source: createTicketSource(
      context({ root, runner: { name: 'Leslie Knope' } })
    ),
    env: {},
    podStore: () => {
      throw new Error('No pod store in this test.');
    },
    readStdin: () => '',
    print: (text) => {
      printed.splice(printed.length, 0, text);
    },
  };
  const program = new Command().exitOverride();
  registerTicketsCommand(program, () => deps);
  const files = tmp('lambda-attach-files-');
  fs.writeFileSync(path.join(files, 'trail.png'), 'the trail map');
  fs.writeFileSync(path.join(files, 'pit.png'), 'the pit');

  return {
    root,
    files,
    printed,
    run: (...args: string[]) =>
      program.parseAsync(['node', 'lambda', 'tickets', ...args]),
  };
};

describe('attach on Linear', () => {
  it('links the uploaded file to the issue, so it is on the ticket', async () => {
    const { fake, source } = linear();
    const files = tmp('lambda-attach-linear-');
    fs.writeFileSync(path.join(files, 'trail.png'), 'the trail map');

    const { ref } = await source.attach(
      'PAWNEE-5',
      path.join(files, 'trail.png')
    );

    expect(fake.attachments).toEqual([
      { issueId: fake.issues[0]?.id, url: ref, title: 'trail.png' },
    ]);
  });
});

describe('image links named like Object properties', () => {
  it('leaves ![x](constructor) as written, matching no ref', () => {
    expect(rewriteImageLinks('![x](constructor)', {})).toBe(
      '![x](constructor)'
    );
  });
});

describe('pushing twice', () => {
  it('Linear: uploads each picture once', async () => {
    const { fake, root, source } = linear();
    await edited(source, root, 'Trail map.\n![trail](trail.png)\n', {
      'trail.png': 'the trail map',
    });
    const { push } = source;
    await push('PAWNEE-5');
    await push('PAWNEE-5');

    expect(fake.uploads.map((upload) => upload.filename)).toEqual([
      'trail.png',
    ]);
    expect(fake.issues[0]?.description).toBe(
      'Trail map.\n![trail](https://uploads.linear.app/pawnee/1/trail.png)\n'
    );
  });

  it('Jira: attaches each picture once', async () => {
    const fake = createJiraFake({
      issues: [{ key: 'PAWNEE-5', summary: 'Volunteer sign-up form' }],
    });
    const opened = context({
      config: {
        source: 'jira',
        statuses: JIRA_FAKE_STATUSES,
        site: JIRA_FAKE_SITE,
        project: JIRA_FAKE_PROJECT,
        prefix: 'PAWNEE',
      },
      tokens: { jira: { email: 'leslie@pawnee.gov', apiToken: 'jira-test' } },
      fetch: fake.fetch,
    });
    const source = createTicketSource(opened);
    await edited(source, opened.root, 'Trail map: ![trail](trail.png)\n', {
      'trail.png': 'the trail map',
    });
    const { push } = source;
    await push('PAWNEE-5');
    await push('PAWNEE-5');

    expect(
      fake.state.issues[0]?.attachments.map((one) => one.filename)
    ).toEqual(['trail.png']);
  });
});

describe('lambda tickets attach and comment --image', () => {
  it('attach on a markdown source prints ./PAWNEE-5/trail.png and saves the file next to the ticket', async () => {
    const { root, files, printed, run } = cli();
    await run('attach', 'PAWNEE-5', path.join(files, 'trail.png'));

    expect(printed).toEqual(['./PAWNEE-5/trail.png']);
    expect(
      fs.readFileSync(
        path.join(root, 'tickets', 'PAWNEE-5', 'trail.png'),
        'utf8'
      )
    ).toBe('the trail map');
  });

  it('attach --alt prints a picture link with that alt text', async () => {
    const { files, printed, run } = cli();
    await run(
      'attach',
      'PAWNEE-5',
      path.join(files, 'trail.png'),
      '--alt',
      'Trail map'
    );

    expect(printed).toEqual(['![Trail map](./PAWNEE-5/trail.png)']);
  });

  it('attach --name keeps two pictures with the same file name apart', async () => {
    const { root, files, printed, run } = cli();
    const twin = path.join(files, 'desk');
    fs.mkdirSync(twin);
    fs.writeFileSync(path.join(twin, 'trail.png'), 'the desk');
    await run(
      'attach',
      'PAWNEE-5',
      path.join(files, 'trail.png'),
      '--name',
      'trail-default.png'
    );
    await run(
      'attach',
      'PAWNEE-5',
      path.join(twin, 'trail.png'),
      '--name',
      'desk-default.png'
    );
    const saved = (name: string): string =>
      fs.readFileSync(path.join(root, 'tickets', 'PAWNEE-5', name), 'utf8');

    expect(printed).toEqual([
      './PAWNEE-5/trail-default.png',
      './PAWNEE-5/desk-default.png',
    ]);
    expect(saved('trail-default.png')).toBe('the trail map');
    expect(saved('desk-default.png')).toBe('the desk');
  });

  it('attach refuses a --name that is not a plain file name', async () => {
    const { root, files, run } = cli();

    await expect(
      run(
        'attach',
        'PAWNEE-5',
        path.join(files, 'trail.png'),
        '--name',
        '../x.png'
      )
    ).rejects.toThrow('--name');
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-5'))).toBe(false);
  });

  it('attach of a missing file fails and attaches nothing', async () => {
    const { root, files, printed, run } = cli();

    await expect(
      run('attach', 'PAWNEE-5', path.join(files, 'gone.png'))
    ).rejects.toThrow('gone.png');
    expect(printed).toEqual([]);
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-5'))).toBe(false);
  });

  it('comment --image pairs each --alt with its --image, in order', async () => {
    const { root, files, run } = cli();
    await run(
      'comment',
      'PAWNEE-5',
      'Trail {{image:1}} first.',
      '--image',
      path.join(files, 'pit.png'),
      '--alt',
      'the pit',
      '--image',
      path.join(files, 'trail.png'),
      '--alt',
      'trail map'
    );

    expect(
      fs.readFileSync(path.join(root, 'tickets', 'PAWNEE-5.md'), 'utf8')
    ).toContain(
      '- Leslie Knope: Trail ![trail map](./PAWNEE-5/trail.png) first.\n  ![the pit](./PAWNEE-5/pit.png)\n'
    );
  });

  it('comment refuses fewer --alt than --image, since it cannot tell which image an alt is for', async () => {
    const { root, files, run } = cli();

    await expect(
      run(
        'comment',
        'PAWNEE-5',
        'Pit.',
        '--image',
        path.join(files, 'pit.png'),
        '--image',
        path.join(files, 'trail.png'),
        '--alt',
        'trail map'
      )
    ).rejects.toThrow('--alt');
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-5.md'))).toBe(
      false
    );
  });

  it('comment refuses more --alt than --image, posting nothing', async () => {
    const { root, files, run } = cli();

    await expect(
      run(
        'comment',
        'PAWNEE-5',
        'Pit.',
        '--image',
        path.join(files, 'pit.png'),
        '--alt',
        'the pit',
        '--alt',
        'another'
      )
    ).rejects.toThrow('--alt');
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-5.md'))).toBe(
      false
    );
  });
});

// ── retries, replaced pictures and credential hosts ─────────────────────────

const jira = (fakeOptions: Parameters<typeof createJiraFake>[0] = {}) => {
  const fake = createJiraFake({
    issues: [{ key: 'PAWNEE-5', summary: 'Volunteer sign-up form' }],
    ...fakeOptions,
  });
  const opened = context({
    config: {
      source: 'jira',
      statuses: JIRA_FAKE_STATUSES,
      site: JIRA_FAKE_SITE,
      project: JIRA_FAKE_PROJECT,
      prefix: 'PAWNEE',
    },
    tokens: { jira: { email: 'leslie@pawnee.gov', apiToken: 'jira-test' } },
    fetch: fake.fetch,
  });

  return { fake, root: opened.root, source: createTicketSource(opened) };
};

/** The Authorization header each request to `url` carried. */
const authFor = (
  seen: Array<{ url: string; headers: RequestInit['headers'] }>,
  url: string
): Array<string | undefined> =>
  seen
    .filter((one) => one.url === url)
    .map((one) => new Headers(one.headers).get('authorization') ?? undefined);

describe('a push that fails part way is safe to retry', () => {
  it('Jira: a retry after the second picture failed attaches the first only once', async () => {
    const rejectAttachments = ['pit.png'];
    const { fake, root, source } = jira({ rejectAttachments });
    await edited(source, root, '![trail](trail.png) ![pit](pit.png)\n', {
      'trail.png': 'the trail map',
      'pit.png': 'the pit',
    });
    const { push } = source;

    await expect(push('PAWNEE-5')).rejects.toThrow();
    rejectAttachments.splice(0);
    await push('PAWNEE-5');

    expect(
      fake.state.issues[0]?.attachments.map((one) => one.filename)
    ).toEqual(['trail.png', 'pit.png']);
  });

  it('Jira: a comment retried after its second picture failed attaches the first only once', async () => {
    const rejectAttachments = ['pit.png'];
    const { fake, source } = jira({ rejectAttachments });
    const files = tmp('lambda-comment-retry-');
    fs.writeFileSync(path.join(files, 'trail.png'), 'the trail map');
    fs.writeFileSync(path.join(files, 'pit.png'), 'the pit');
    const images = [
      { path: path.join(files, 'trail.png') },
      { path: path.join(files, 'pit.png') },
    ];

    await expect(
      source.comment('PAWNEE-5', 'Both.', { images })
    ).rejects.toThrow();
    rejectAttachments.splice(0);
    await source.comment('PAWNEE-5', 'Both.', { images });

    expect(
      fake.state.issues[0]?.attachments.map((one) => one.filename)
    ).toEqual(['trail.png', 'pit.png']);
  });
});

describe('a replaced picture is uploaded again', () => {
  it('Linear: re-rendering trail.png and pushing again uploads the new one and links it', async () => {
    const { fake, root, source } = linear();
    const dir = await edited(
      source,
      root,
      'Trail map.\n![trail](trail.png)\n',
      {
        'trail.png': 'the trail map',
      }
    );
    const { push } = source;
    await push('PAWNEE-5');
    fs.writeFileSync(path.join(dir, 'trail.png'), 'the trail map, v2');
    await push('PAWNEE-5');
    const second = fake.uploads[1]?.assetUrl ?? '?';

    expect(fake.uploads.map((upload) => upload.body)).toEqual([
      'the trail map',
      'the trail map, v2',
    ]);
    expect(fake.issues[0]?.description).toBe(
      `Trail map.\n![trail](${second})\n`
    );
  });
});

describe('credentials go only to the exact host, port included', () => {
  it('Linear: an image on uploads.linear.app:444 is fetched without the key', async () => {
    const url = 'https://uploads.linear.app:444/pawnee/x.png';
    const fake = createLinearFake({ files: { [url]: 'x' } });
    fake.add({
      identifier: 'PAWNEE-5',
      title: 'Volunteer sign-up form',
      description: `![x](${url})\n`,
    });
    const seen: Array<{ url: string; headers: RequestInit['headers'] }> = [];
    const source = createTicketSource(
      context({
        config: {
          source: 'linear',
          statuses: PAWNEE_STATUSES,
          team: 'PAWNEE',
          prefix: 'PAWNEE',
        },
        tokens: { linear: 'lin_api_test' },
        fetch: async (input, init) => {
          seen.splice(seen.length, 0, {
            url: String(input),
            headers: init?.headers,
          });

          return fake.fetch(input, init);
        },
      })
    );
    await source.pull('PAWNEE-5');

    expect(authFor(seen, url)).toEqual([undefined]);
  });

  it('Jira: an attachment on the site host at another port is fetched without the token', async () => {
    const url = `${JIRA_FAKE_SITE}:8443/x.png`;
    const { fake, root } = jira({ files: { [url]: 'x' } });
    const [issue] = fake.state.issues;

    if (issue === undefined) {
      throw new Error('The fake has no PAWNEE-5.');
    }

    issue.attachments = [{ id: '901', filename: 'x.png', content: url }];
    const seen: Array<{ url: string; headers: RequestInit['headers'] }> = [];
    const source = createTicketSource(
      context({
        root,
        config: {
          source: 'jira',
          statuses: JIRA_FAKE_STATUSES,
          site: JIRA_FAKE_SITE,
          project: JIRA_FAKE_PROJECT,
          prefix: 'PAWNEE',
        },
        tokens: {
          jira: { email: 'leslie@pawnee.gov', apiToken: 'jira-test' },
        },
        fetch: async (input, init) => {
          seen.splice(seen.length, 0, {
            url: String(input),
            headers: init?.headers,
          });

          return fake.fetch(input, init);
        },
      })
    );
    await source.pull('PAWNEE-5');

    expect(authFor(seen, url)).toEqual([undefined]);
  });
});

describe('markdown attach refs', () => {
  it('escapes # in a file name, so the link still finds shot#1.png', async () => {
    const { root, files, printed, run } = cli();
    fs.writeFileSync(path.join(files, 'shot#1.png'), 'the first shot');
    await run('attach', 'PAWNEE-5', path.join(files, 'shot#1.png'));

    expect(printed).toEqual(['./PAWNEE-5/shot%231.png']);
    expect(
      fs.readFileSync(
        path.join(root, 'tickets', 'PAWNEE-5', 'shot#1.png'),
        'utf8'
      )
    ).toBe('the first shot');
  });
});
