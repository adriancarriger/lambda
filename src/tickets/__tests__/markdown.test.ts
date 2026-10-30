import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import realFs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type TicketsConfig,
  loadProjectConfig,
} from '../../config/projectConfig';
import { writeKnownAssignees } from '../../runner/localFiles';
import { type SourceContext, openTicketSource } from '../context';
import { createMarkdownSource } from '../markdown';
import { type TicketSource } from '../source';

const TASKS = [
  '# Pawnee Parks app',
  '',
  '- [ ] PAWNEE-1: Park map page',
  '  - [x] PAWNEE-1a: Map tiles',
  '  - [ ] PAWNEE-1b: Pins for each park',
  '- [B] PAWNEE-2: Volunteer sign-up form (blocked: Ann Perkins is out)',
  '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
  '',
].join('\n');

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-markdown-')));

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const read = (file: string): string => fs.readFileSync(file, 'utf8');

const context = (
  root: string,
  config: Partial<TicketsConfig> = {}
): SourceContext => ({
  root,
  config: { source: 'markdown', prefix: 'PAWNEE', ...config },
  tokens: undefined,
  env: {},
  fetch: () => {
    throw new Error('No network');
  },
  runner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
});

const project = (
  tasks: string = TASKS,
  files: Record<string, string> = {}
): { root: string; source: TicketSource; tasksFile: string } => {
  const root = tmp();
  const tasksFile = path.join(root, 'TASKS.md');
  write(tasksFile, tasks);
  Object.entries(files).forEach(([file, text]) =>
    write(path.join(root, file), text)
  );

  return { root, source: createMarkdownSource(context(root)), tasksFile };
};

describe('reading an open-source TASKS.md', () => {
  it('reads children and a block reason, and writes the file back byte for byte', async () => {
    const { source, tasksFile } = project();
    const tickets = await source.list();

    expect(tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
      ['PAWNEE-1', 'ready'],
      ['PAWNEE-1a', 'done'],
      ['PAWNEE-1b', 'ready'],
      ['PAWNEE-2', 'blocked'],
      ['PAWNEE-3', 'ready'],
    ]);
    expect(tickets[0]).toEqual({
      id: 'PAWNEE-1',
      title: 'Park map page',
      status: 'ready',
      labels: [],
      parent: null,
      children: ['PAWNEE-1a', 'PAWNEE-1b'],
      blockedBy: [],
      blockReason: null,
      reporter: null,
      url: null,
      priority: 'none',
      assignee: null,
      project: null,
      updatedAt: null,
    });
    expect(tickets[2]?.parent).toBe('PAWNEE-1');
    expect(tickets[3]?.title).toBe('Volunteer sign-up form');
    expect(tickets[3]?.blockReason).toBe('Ann Perkins is out');

    // Real changes, each undone: the file is written every time.
    await source.update('PAWNEE-2', { status: 'done' });

    expect(read(tasksFile)).not.toBe(TASKS);

    await source.update('PAWNEE-2', {
      status: 'blocked',
      reason: 'Ann Perkins is out',
    });

    expect(read(tasksFile)).toBe(TASKS);

    await source.place(['PAWNEE-3'], 'PAWNEE-1');

    expect(read(tasksFile)).not.toBe(TASKS);

    await source.place(['PAWNEE-2'], 'PAWNEE-1');

    expect(read(tasksFile)).toBe(TASKS);

    await source.reorder('PAWNEE-1', ['PAWNEE-1b', 'PAWNEE-1a']);

    expect(read(tasksFile)).not.toBe(TASKS);

    await source.reorder('PAWNEE-1', ['PAWNEE-1a', 'PAWNEE-1b']);

    expect(read(tasksFile)).toBe(TASKS);
  });

  it('keeps the checkbox [ ] for building and writes the state to the front matter', async () => {
    const { root, source, tasksFile } = project();

    await source.update('PAWNEE-3', { status: 'building' });

    expect(read(tasksFile)).toBe(TASKS);
    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toMatch(
      /^---\nstatus: building\n---\n# Lot 48 pit photo gallery\n/
    );
    expect((await source.get('PAWNEE-3')).status).toBe('building');
  });

  it('reads [x] and [B] whatever the front matter says, and [ ] from the file', async () => {
    const { source } = project(TASKS, {
      'tickets/PAWNEE-1a.md': '---\nstatus: building\n---\n# Map tiles\n',
      'tickets/PAWNEE-2.md': '---\nstatus: ready\n---\n# Volunteer\n',
      'tickets/PAWNEE-3.md': '---\nstatus: planning\n---\n# Lot 48\n',
      'tickets/PAWNEE-1.md': '---\nstatus: shipped\n---\n# Park map page\n',
      'tickets/PAWNEE-1b.md': '# Pins, no front matter\n',
    });
    const status = async (id: string) => (await source.get(id)).status;

    expect(await status('PAWNEE-1a')).toBe('done');
    expect(await status('PAWNEE-2')).toBe('blocked');
    expect(await status('PAWNEE-3')).toBe('planning');
    expect(await status('PAWNEE-1')).toBe('ready');
    expect(await status('PAWNEE-1b')).toBe('ready');
  });
});

describe('next', () => {
  const next = async (tasks: string, files: Record<string, string> = {}) =>
    (await project(tasks, files).source.next())?.id ?? null;

  it("runs a parent's first open child", async () => {
    expect(await next(TASKS)).toBe('PAWNEE-1b');
  });

  it('skips the parent when its next child is blocked, even with a ready child after it', async () => {
    const blockedChild = TASKS.replace(
      '  - [ ] PAWNEE-1b: Pins for each park',
      '  - [B] PAWNEE-1b: Pins for each park\n  - [ ] PAWNEE-1c: Park benches'
    ).replace('- [B] PAWNEE-2', '- [x] PAWNEE-2');

    expect(await next(blockedChild)).toBe('PAWNEE-3');
  });

  it('skips a ticket whose blocker is not done, or whose blocker no longer exists', async () => {
    const tasks = [
      '- [ ] PAWNEE-2: Volunteer sign-up form',
      '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
      '- [ ] PAWNEE-4: Harvest festival',
      '- [ ] PAWNEE-5: Ice Town sign-up',
      '',
    ].join('\n');

    expect(
      await next(tasks, {
        'tickets/PAWNEE-2.md': '---\nblockedBy: [PAWNEE-3]\n---\n# V\n',
        'tickets/PAWNEE-3.md': '---\nstatus: planning\n---\n# L\n',
        'tickets/PAWNEE-4.md': '---\nblockedBy: [PAWNEE-99]\n---\n# H\n',
      })
    ).toBe('PAWNEE-5');
  });

  it("runs a building parent's next child, as in the ticket's own list", async () => {
    expect(
      await next(TASKS, {
        'tickets/PAWNEE-1.md': '---\nstatus: building\n---\n# Park map page\n',
      })
    ).toBe('PAWNEE-1b');
  });

  it('never hands out a building parent itself, even with its children done', async () => {
    expect(
      await next(
        '- [ ] PAWNEE-1: Park map page\n  - [x] PAWNEE-1a: Map tiles\n- [ ] PAWNEE-2: Volunteer\n',
        { 'tickets/PAWNEE-1.md': '---\nstatus: building\n---\n# P\n' }
      )
    ).toBe('PAWNEE-2');
    expect(
      await next('- [ ] PAWNEE-1: Park map page\n- [ ] PAWNEE-2: Volunteer\n', {
        'tickets/PAWNEE-1.md': '---\nstatus: building\n---\n# P\n',
      })
    ).toBe('PAWNEE-2');
  });

  it('reads quoted values and a YAML list in the front matter', async () => {
    const tasks = [
      '- [ ] PAWNEE-2: Volunteer sign-up form',
      '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
      '- [ ] PAWNEE-4: Harvest festival',
      '',
    ].join('\n');

    expect(
      await next(tasks, {
        'tickets/PAWNEE-2.md': '---\nblockedBy:\n  - "PAWNEE-4"\n---\n# V\n',
        'tickets/PAWNEE-3.md': '---\nstatus: "planning"\n---\n# L\n',
      })
    ).toBe('PAWNEE-4');
  });

  it('returns a parent whose children are all done', async () => {
    expect(
      await next(
        '- [ ] PAWNEE-1: Park map page\n  - [x] PAWNEE-1a: Map tiles\n'
      )
    ).toBe('PAWNEE-1');
  });

  it('returns null when nothing is eligible', async () => {
    expect(
      await next('- [x] PAWNEE-1: Park map page\n- [B] PAWNEE-2: Volunteer\n')
    ).toBeNull();
  });

  it('filters by reporter', async () => {
    const { source } = project(
      "- [ ] PAWNEE-1: Ron's woodshop\n- [ ] PAWNEE-2: Leslie's gazebo\n",
      {
        'tickets/PAWNEE-1.md':
          '---\nreporter: Ron Swanson <ron@pawnee.gov>\n---\n# W\n',
        'tickets/PAWNEE-2.md':
          '---\nreporter: Leslie Knope <leslie@pawnee.gov>\n---\n# G\n',
      }
    );

    expect((await source.next({ reporter: 'LESLIE@pawnee.gov' }))?.id).toBe(
      'PAWNEE-2'
    );
    expect(
      (await source.list({ reporter: 'ron swanson' })).map((t) => t.id)
    ).toEqual(['PAWNEE-1']);
  });
});

describe('create', () => {
  it('numbers top-level tickets and lettered children, in place', async () => {
    const { root, source, tasksFile } = project();

    expect((await source.create({ title: 'Harvest festival' })).id).toBe(
      'PAWNEE-4'
    );
    expect((await source.create({ title: 'Ice Town sign-up' })).id).toBe(
      'PAWNEE-5'
    );

    const child = await source.create({
      title: 'Park benches',
      parent: 'PAWNEE-1',
    });

    expect(child.id).toBe('PAWNEE-1c');
    expect(child.parent).toBe('PAWNEE-1');
    expect(read(tasksFile)).toBe(
      [
        '# Pawnee Parks app',
        '',
        '- [ ] PAWNEE-1: Park map page',
        '  - [x] PAWNEE-1a: Map tiles',
        '  - [ ] PAWNEE-1b: Pins for each park',
        '  - [ ] PAWNEE-1c: Park benches',
        '- [B] PAWNEE-2: Volunteer sign-up form (blocked: Ann Perkins is out)',
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
        '- [ ] PAWNEE-4: Harvest festival',
        '- [ ] PAWNEE-5: Ice Town sign-up',
        '',
      ].join('\n')
    );
    expect(read(path.join(root, 'tickets', 'PAWNEE-4.md'))).toBe(
      '---\nstatus: inbox\nreporter: Leslie Knope <leslie@pawnee.gov>\n---\n# Harvest festival\n'
    );
    expect((await source.get('PAWNEE-4')).status).toBe('inbox');
  });

  it('indents a first child two spaces under its parent', async () => {
    const { source, tasksFile } = project('- [ ] PAWNEE-3: Lot 48\n');

    expect(
      (await source.create({ title: 'Fill', parent: 'PAWNEE-3' })).id
    ).toBe('PAWNEE-3a');
    expect(read(tasksFile)).toBe(
      '- [ ] PAWNEE-3: Lot 48\n  - [ ] PAWNEE-3a: Fill\n'
    );
  });

  it('refuses with no prefix, naming tickets.prefix', async () => {
    const root = tmp();
    write(path.join(root, 'TASKS.md'), TASKS);
    const source = createMarkdownSource(context(root, { prefix: undefined }));

    await expect(source.create({ title: 'Lot 48' })).rejects.toThrow(
      'tickets.prefix'
    );
    await expect(
      source.create({ title: 'Park benches', parent: 'PAWNEE-1' })
    ).rejects.toThrow('tickets.prefix');
    expect(read(path.join(root, 'TASKS.md'))).toBe(TASKS);
  });

  it('writes the description under the title', async () => {
    const { root, source } = project();
    const { id } = await source.create({
      title: 'Lot 48',
      description: 'Fill the pit.',
    });

    expect(read(path.join(root, 'tickets', `${id}.md`))).toMatch(
      /\n# Lot 48\n\nFill the pit\.\n$/
    );
    expect((await source.get(id)).description).toBe('Fill the pit.');
  });

  it('writes no reporter when nobody is running it', async () => {
    const root = tmp();
    write(path.join(root, 'TASKS.md'), TASKS);
    const source = createMarkdownSource({ ...context(root), runner: null });
    const created = await source.create({ title: 'Lot 48' });

    expect(created.reporter).toBeNull();
    expect(read(path.join(root, 'tickets', `${created.id}.md`))).not.toContain(
      'reporter'
    );
  });

  it('from a pod worktree, writes to the main checkout', async () => {
    const tmpRoot = tmp();
    const main = path.join(tmpRoot, 'main');
    const worktree = path.join(tmpRoot, 'pod-worktree');
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Leslie Knope',
      GIT_AUTHOR_EMAIL: 'leslie@pawnee.gov',
      GIT_COMMITTER_NAME: 'Leslie Knope',
      GIT_COMMITTER_EMAIL: 'leslie@pawnee.gov',
    };
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', args, { cwd, env, stdio: 'ignore' });
    };
    write(
      path.join(main, 'lambda.json'),
      JSON.stringify({ tickets: { source: 'markdown', prefix: 'PAWNEE' } })
    );
    write(path.join(main, 'TASKS.md'), TASKS);
    git(main, ['init', '-q']);
    git(main, ['add', '.']);
    git(main, ['commit', '-q', '-m', 'Pawnee']);
    git(main, ['worktree', 'add', '-q', '--detach', worktree]);

    const found = loadProjectConfig(worktree);

    if (found === null) {
      throw new Error('No project found from the worktree');
    }

    const source = openTicketSource(
      found,
      { owner: { name: 'Leslie Knope' } },
      {}
    );
    const { id, reporter } = await source.create({ title: 'Ice Town sign-up' });

    expect(reporter?.name).toBe('Leslie Knope');

    expect(id).toBe('PAWNEE-4');
    expect(read(path.join(main, 'TASKS.md'))).toContain(
      '- [ ] PAWNEE-4: Ice Town sign-up'
    );
    expect(fs.existsSync(path.join(main, 'tickets', 'PAWNEE-4.md'))).toBe(true);
    expect(read(path.join(worktree, 'TASKS.md'))).toBe(TASKS);
    expect(fs.existsSync(path.join(worktree, 'tickets'))).toBe(false);
  });
});

describe('writing safely', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes every file to a temp file in its folder and renames it into place', async () => {
    const { root, source, tasksFile } = project();
    const ticketFile = path.join(root, 'tickets', 'PAWNEE-3.md');
    const written = jest.spyOn(realFs, 'writeFileSync');
    const renamed = jest.spyOn(realFs, 'renameSync');

    await source.update('PAWNEE-3', { status: 'blocked', reason: 'Fence' });
    await source.comment('PAWNEE-3', 'Andy fell in again.');

    const writes = written.mock.calls.map(([file]) => String(file));
    const renames = renamed.mock.calls.map(([from, to]) => [
      String(from),
      String(to),
    ]);

    expect(writes).not.toContain(tasksFile);
    expect(writes).not.toContain(ticketFile);
    // update writes the ticket file before its queue line, as create does.
    expect(renames.map(([, to]) => to)).toEqual([
      ticketFile,
      tasksFile,
      ticketFile,
    ]);
    renames.forEach(([from, to]) => {
      expect(writes).toContain(from);
      expect(from).not.toBe(to);
      expect(path.dirname(from ?? '')).toBe(path.dirname(to ?? ''));
    });
    expect(fs.readdirSync(root).sort()).toEqual(['TASKS.md', 'tickets']);
    expect(fs.readdirSync(path.join(root, 'tickets'))).toEqual(['PAWNEE-3.md']);
    expect(read(ticketFile)).toContain('- Leslie Knope: Andy fell in again.');
  });

  it('create writes the ticket file before its queue line', async () => {
    const { root, source, tasksFile } = project();
    const renamed = jest.spyOn(realFs, 'renameSync');

    await source.create({ title: 'Ice Town sign-up' });

    expect(renamed.mock.calls.map(([, to]) => String(to))).toEqual([
      path.join(root, 'tickets', 'PAWNEE-4.md'),
      tasksFile,
    ]);
  });
});

describe('comments, line endings and pull/push', () => {
  it('creates the ticket file to comment on, under ## Comments', async () => {
    const { root, source } = project();

    await source.comment('PAWNEE-3', 'Lot 48 needs a fence.');
    await source.comment('PAWNEE-3', 'Andy fell in again.');

    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
      '# Lot 48 pit photo gallery\n\n## Comments\n\n- Leslie Knope: Lot 48 needs a fence.\n- Leslie Knope: Andy fell in again.\n'
    );
  });

  it('adds a comment under ## Comments even when another section follows it', async () => {
    const { root, source } = project(TASKS, {
      'tickets/PAWNEE-3.md':
        '# Lot 48\n\n## Comments\n\n- Ann Perkins: Fence it.\n\n## Notes\n\nBring shovels.\n',
    });

    await source.comment('PAWNEE-3', 'Andy fell in again.');

    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
      '# Lot 48\n\n## Comments\n\n- Ann Perkins: Fence it.\n- Leslie Knope: Andy fell in again.\n\n## Notes\n\nBring shovels.\n'
    );
  });

  it('adds the first comment under an empty ## Comments heading', async () => {
    const { root, source } = project(TASKS, {
      'tickets/PAWNEE-3.md': '# Lot 48\n\n## Comments\n\n## Notes\n',
    });

    await source.comment('PAWNEE-3', 'Andy fell in again.');

    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
      '# Lot 48\n\n## Comments\n\n- Leslie Knope: Andy fell in again.\n\n## Notes\n'
    );
  });

  it('refuses front matter it can’t read, naming the file and line, and changes nothing', async () => {
    const ticket = '---\nstatus: ready\n# who asked: Ron\n---\n# Lot 48\n';
    const { root, source } = project(TASKS, { 'tickets/PAWNEE-3.md': ticket });

    await expect(
      source.update('PAWNEE-3', { status: 'building' })
    ).rejects.toThrow(
      `${path.join('tickets', 'PAWNEE-3.md')}:3: Lambda reads front matter`
    );
    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(ticket);
  });

  it('keeps a YAML-list blockedBy through a write', async () => {
    const { root, source } = project(TASKS, {
      'tickets/PAWNEE-3.md': '---\nblockedBy:\n  - PAWNEE-1\n---\n# Lot 48\n',
    });

    await source.update('PAWNEE-3', { status: 'building' });

    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
      '---\nblockedBy: [PAWNEE-1]\nstatus: building\n---\n# Lot 48\n'
    );
  });

  it('keeps CRLF and a missing final newline through an update', async () => {
    const crlf = TASKS.replace(/\n/g, '\r\n').replace(/\r\n$/, '');
    const { source, tasksFile } = project(crlf);

    await source.update('PAWNEE-3', { status: 'blocked', reason: 'Fence' });

    expect(read(tasksFile)).toBe(
      crlf.replace(
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
        '- [B] PAWNEE-3: Lot 48 pit photo gallery (blocked: Fence)'
      )
    );

    await source.update('PAWNEE-3', { status: 'ready' });

    expect(read(tasksFile)).toBe(crlf);
  });

  it('pull creates the file and gives its path; push has nothing to do', async () => {
    const { root, source } = project();

    expect(await source.pull('PAWNEE-1')).toBe(
      path.join('tickets', 'PAWNEE-1.md')
    );
    expect(read(path.join(root, 'tickets', 'PAWNEE-1.md'))).toBe(
      '# Park map page\n'
    );
    const { push } = source;

    expect(await push('PAWNEE-1')).toBe(
      'Nothing to push: markdown tickets are already the files.'
    );
  });
});

describe('staying inside the project', () => {
  it('refuses a bad id, a dir outside the project and a symlinked tickets folder', async () => {
    const { root, source } = project();
    const outside = tmp();

    await expect(source.get('../evil')).rejects.toThrow("isn't a ticket id");
    await expect(
      createMarkdownSource(context(root, { dir: '../elsewhere' })).comment(
        'PAWNEE-1',
        'Hi'
      )
    ).rejects.toThrow('outside the project');

    fs.symlinkSync(outside, path.join(root, 'tickets'));

    await expect(source.comment('PAWNEE-1', 'Hi')).rejects.toThrow(
      'outside the project'
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(root), 'elsewhere'))).toBe(
      false
    );
  });

  it('allows a folder whose name merely starts with two dots', async () => {
    const { root } = project();
    const source = createMarkdownSource(context(root, { dir: '..tickets' }));

    await source.comment('PAWNEE-3', 'Fence it.');

    expect(read(path.join(root, '..tickets', 'PAWNEE-3.md'))).toContain(
      '- Leslie Knope: Fence it.'
    );
  });

  it('refuses a queue that is a symlink to a file outside the project', async () => {
    const root = tmp();
    const outside = tmp();
    const outsideTasks = path.join(outside, 'TASKS.md');
    write(outsideTasks, TASKS);
    fs.symlinkSync(outsideTasks, path.join(root, 'TASKS.md'));
    const source = createMarkdownSource(context(root, { queue: 'TASKS.md' }));

    await expect(source.list()).rejects.toThrow('outside the project');
    await expect(source.create({ title: 'Lot 48' })).rejects.toThrow(
      'outside the project'
    );
    await expect(source.update('PAWNEE-3', { status: 'done' })).rejects.toThrow(
      'outside the project'
    );
    expect(read(outsideTasks)).toBe(TASKS);
    expect(fs.readdirSync(outside)).toEqual(['TASKS.md']);
    expect(fs.existsSync(path.join(root, 'tickets'))).toBe(false);
  });
});

describe('status, blocks, labels and the edge cases', () => {
  it('writes and clears a block reason', async () => {
    const { source, tasksFile } = project();

    await source.update('PAWNEE-3', {
      status: 'blocked',
      reason: 'Ann Perkins is out',
    });

    expect(read(tasksFile)).toContain(
      '- [B] PAWNEE-3: Lot 48 pit photo gallery (blocked: Ann Perkins is out)'
    );

    await source.update('PAWNEE-2', { status: 'ready' });

    expect(read(tasksFile)).toContain(
      '- [ ] PAWNEE-2: Volunteer sign-up form\n'
    );

    await source.update('PAWNEE-2', { status: 'blocked' });

    expect(read(tasksFile)).toContain(
      '- [B] PAWNEE-2: Volunteer sign-up form\n'
    );

    await source.update('PAWNEE-2', { status: 'done' });

    expect(read(tasksFile)).toContain(
      '- [x] PAWNEE-2: Volunteer sign-up form\n'
    );
  });

  it('reads a block reason that holds its own brackets, and only on a [B] line', async () => {
    const { source, tasksFile } = project(
      [
        '- [B] PAWNEE-2: Volunteer sign-up form (blocked: Ann Perkins is out (sick))',
        '- [ ] PAWNEE-3: Rename "(blocked: x)" in the docs',
        '',
      ].join('\n')
    );

    expect(await source.get('PAWNEE-2')).toMatchObject({
      title: 'Volunteer sign-up form',
      blockReason: 'Ann Perkins is out (sick)',
    });
    expect(await source.get('PAWNEE-3')).toMatchObject({
      title: 'Rename "(blocked: x)" in the docs',
      blockReason: null,
    });

    await source.update('PAWNEE-2', { status: 'blocked', reason: 'Fence' });

    expect(read(tasksFile)).toContain(
      '- [B] PAWNEE-2: Volunteer sign-up form (blocked: Fence)\n'
    );
  });

  it('refuses to delete a ticket with children, and leaves TASKS.md alone', async () => {
    const { source, tasksFile } = project();

    await expect(source.delete('PAWNEE-1', 'Not needed')).rejects.toThrow(
      'PAWNEE-1 still has children: PAWNEE-1a, PAWNEE-1b.'
    );
    expect(read(tasksFile)).toBe(TASKS);
  });

  it('deletes a leaf: its line and its file', async () => {
    const { root, source, tasksFile } = project(TASKS, {
      'tickets/PAWNEE-3.md': '# Lot 48\n',
    });

    await source.delete('PAWNEE-3', 'Filled in');

    expect(read(tasksFile)).not.toContain('PAWNEE-3');
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
      false
    );
  });

  it('reads an unknown id as not a ticket, and blocks on one write nothing', async () => {
    const { root, source } = project();

    await expect(source.get('PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
    await expect(source.block('PAWNEE-2', 'PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-2.md'))).toBe(
      false
    );
  });

  it('blocks and unblocks through the front matter, leaving the checkbox', async () => {
    const { root, source, tasksFile } = project();

    await source.block('PAWNEE-3', 'PAWNEE-1');
    await source.block('PAWNEE-3', 'PAWNEE-1');

    expect(read(tasksFile)).toBe(TASKS);
    expect((await source.get('PAWNEE-3')).blockedBy).toEqual(['PAWNEE-1']);
    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toContain(
      'blockedBy: [PAWNEE-1]'
    );

    await source.unblock('PAWNEE-3', 'PAWNEE-1');

    expect((await source.get('PAWNEE-3')).blockedBy).toEqual([]);
  });

  it('adds labels once, and renames a ticket', async () => {
    const { source, tasksFile } = project();

    await source.update('PAWNEE-3', { labels: ['planned', 'parks'] });
    await source.update('PAWNEE-3', {
      labels: ['planned'],
      title: 'Lot 48 park',
    });

    const ticket = await source.get('PAWNEE-3');

    expect(ticket.labels).toEqual(['planned', 'parks']);
    expect(ticket.title).toBe('Lot 48 park');
    expect(read(tasksFile)).toContain('- [ ] PAWNEE-3: Lot 48 park\n');
  });

  it('refuses an unknown status', async () => {
    const { source } = project();

    await expect(
      source.update('PAWNEE-3', JSON.parse('{ "status": "shipped" }'))
    ).rejects.toThrow('planning, ready, building, blocked, done, canceled');
  });
});

describe('reorder and place', () => {
  const tasks = [
    '- [ ] PAWNEE-1: Park map page',
    '  - [x] PAWNEE-1a: Map tiles',
    '  - [ ] PAWNEE-1b: Pins for each park',
    '  - [ ] PAWNEE-1c: Park benches',
    '- [ ] PAWNEE-2: Volunteer sign-up form',
    '',
    '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
    '- [ ] PAWNEE-4: Harvest festival',
    '',
  ].join('\n');

  it("reorders a parent's children", async () => {
    const { source, tasksFile } = project(tasks);

    await source.reorder('PAWNEE-1', ['PAWNEE-1a', 'PAWNEE-1c', 'PAWNEE-1b']);

    expect(read(tasksFile)).toBe(
      tasks.replace(
        '  - [ ] PAWNEE-1b: Pins for each park\n  - [ ] PAWNEE-1c: Park benches',
        '  - [ ] PAWNEE-1c: Park benches\n  - [ ] PAWNEE-1b: Pins for each park'
      )
    );
  });

  it('refuses an order that is not exactly the children, naming what is off', async () => {
    const { source, tasksFile } = project(tasks);
    const refusal = source.reorder('PAWNEE-1', ['PAWNEE-1a', 'PAWNEE-2']);

    await expect(refusal).rejects.toThrow('missing PAWNEE-1b, PAWNEE-1c');
    await expect(
      source.reorder('PAWNEE-1', ['PAWNEE-1a', 'PAWNEE-2'])
    ).rejects.toThrow('not its children: PAWNEE-2');
    expect(read(tasksFile)).toBe(tasks);
  });

  it('places a block after a ticket, children and all', async () => {
    const { source, tasksFile } = project(tasks);

    await source.place(['PAWNEE-1', 'PAWNEE-2'], 'PAWNEE-3');

    expect(read(tasksFile)).toBe(
      [
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
        '- [ ] PAWNEE-1: Park map page',
        '  - [x] PAWNEE-1a: Map tiles',
        '  - [ ] PAWNEE-1b: Pins for each park',
        '  - [ ] PAWNEE-1c: Park benches',
        '',
        '- [ ] PAWNEE-2: Volunteer sign-up form',
        '- [ ] PAWNEE-4: Harvest festival',
        '',
      ].join('\n')
    );
  });

  it('refuses to place a ticket twice, and leaves TASKS.md alone', async () => {
    const { source, tasksFile } = project(tasks);

    await expect(
      source.place(['PAWNEE-1', 'PAWNEE-1'], 'PAWNEE-3')
    ).rejects.toThrow("Can't place a ticket twice: PAWNEE-1 is repeated.");
    expect(read(tasksFile)).toBe(tasks);
  });

  it('place after an unknown ticket is the unknown-id message', async () => {
    const { source } = project(tasks);

    await expect(source.place(['PAWNEE-1'], 'PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
  });
});

describe('notes under a ticket', () => {
  const tasks = [
    '# Pawnee Parks app',
    '',
    '- [ ] PAWNEE-1: Park map page',
    '  Tiles from county GIS.',
    '  - [x] PAWNEE-1a: Map tiles',
    '    Ask Ben for the budget.',
    '  - [ ] PAWNEE-1b: Pins for each park',
    '    One pin per park.',
    '- [ ] PAWNEE-2: Volunteer sign-up form',
    '  Ann Perkins has the list.',
    '',
    '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
    '  Fill it in first.',
    '',
  ].join('\n');

  it('move with their ticket when it is placed', async () => {
    const { source, tasksFile } = project(tasks);

    await source.place(['PAWNEE-1'], 'PAWNEE-2');

    expect(read(tasksFile)).toBe(
      [
        '# Pawnee Parks app',
        '',
        '- [ ] PAWNEE-2: Volunteer sign-up form',
        '  Ann Perkins has the list.',
        '- [ ] PAWNEE-1: Park map page',
        '  Tiles from county GIS.',
        '  - [x] PAWNEE-1a: Map tiles',
        '    Ask Ben for the budget.',
        '  - [ ] PAWNEE-1b: Pins for each park',
        '    One pin per park.',
        '',
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
        '  Fill it in first.',
        '',
      ].join('\n')
    );
  });

  it('move with their child when the children are reordered', async () => {
    const { source, tasksFile } = project(tasks);

    await source.reorder('PAWNEE-1', ['PAWNEE-1b', 'PAWNEE-1a']);

    expect(read(tasksFile)).toBe(
      tasks.replace(
        '  - [x] PAWNEE-1a: Map tiles\n    Ask Ben for the budget.\n  - [ ] PAWNEE-1b: Pins for each park\n    One pin per park.\n',
        '  - [ ] PAWNEE-1b: Pins for each park\n    One pin per park.\n  - [x] PAWNEE-1a: Map tiles\n    Ask Ben for the budget.\n'
      )
    );
  });

  it('go with their ticket when it is deleted', async () => {
    const { source, tasksFile } = project(tasks);

    await source.delete('PAWNEE-1b', 'Folded into the map');
    await source.delete('PAWNEE-2', 'Ann Perkins took it');

    expect(read(tasksFile)).toBe(
      tasks
        .replace(
          '  - [ ] PAWNEE-1b: Pins for each park\n    One pin per park.\n',
          ''
        )
        .replace(
          '- [ ] PAWNEE-2: Volunteer sign-up form\n  Ann Perkins has the list.\n',
          ''
        )
    );
  });

  it('stay with the child above them when a child is created', async () => {
    const { source, tasksFile } = project(tasks);

    expect(
      (await source.create({ title: 'Park benches', parent: 'PAWNEE-1' })).id
    ).toBe('PAWNEE-1c');
    expect(
      (await source.create({ title: 'Fill', parent: 'PAWNEE-3' })).id
    ).toBe('PAWNEE-3a');
    expect(read(tasksFile)).toBe(
      [
        '# Pawnee Parks app',
        '',
        '- [ ] PAWNEE-1: Park map page',
        '  Tiles from county GIS.',
        '  - [x] PAWNEE-1a: Map tiles',
        '    Ask Ben for the budget.',
        '  - [ ] PAWNEE-1b: Pins for each park',
        '    One pin per park.',
        '  - [ ] PAWNEE-1c: Park benches',
        '- [ ] PAWNEE-2: Volunteer sign-up form',
        '  Ann Perkins has the list.',
        '',
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
        '  Fill it in first.',
        '  - [ ] PAWNEE-3a: Fill',
        '',
      ].join('\n')
    );
  });
});

describe('ids that were used before', () => {
  it("never reuses a deleted ticket's number while a ticket is blocked by it", async () => {
    const { source } = project();

    expect((await source.create({ title: 'Harvest festival' })).id).toBe(
      'PAWNEE-4'
    );

    await source.block('PAWNEE-2', 'PAWNEE-4');
    await source.delete('PAWNEE-4', 'Moved to next year');

    expect((await source.create({ title: 'Ice Town sign-up' })).id).toBe(
      'PAWNEE-5'
    );
    expect((await source.get('PAWNEE-2')).blockedBy).toEqual(['PAWNEE-4']);
  });

  it("never reuses a deleted child's letter while a ticket is blocked by it", async () => {
    const { source } = project(
      TASKS.replace(
        '  - [ ] PAWNEE-1b: Pins for each park',
        '  - [ ] PAWNEE-1b: Pins for each park\n  - [ ] PAWNEE-1c: Park benches'
      ),
      { 'tickets/PAWNEE-3.md': '---\nblockedBy: [PAWNEE-1c]\n---\n# L\n' }
    );

    await source.delete('PAWNEE-1c', 'No benches');

    expect(
      (await source.create({ title: 'Swings', parent: 'PAWNEE-1' })).id
    ).toBe('PAWNEE-1d');
  });

  it('never gives a child an id already used elsewhere in TASKS.md', async () => {
    const tasks = [
      '- [ ] PAWNEE-1: Park map page',
      '  - [x] PAWNEE-1a: Map tiles',
      '- [ ] PAWNEE-1b: Pins for each park, moved to the top by hand',
      '',
    ].join('\n');
    const { source, tasksFile } = project(tasks);

    expect(
      (await source.create({ title: 'Park benches', parent: 'PAWNEE-1' })).id
    ).toBe('PAWNEE-1c');
    expect(read(tasksFile)).toBe(
      tasks.replace(
        '  - [x] PAWNEE-1a: Map tiles\n',
        '  - [x] PAWNEE-1a: Map tiles\n  - [ ] PAWNEE-1c: Park benches\n'
      )
    );
  });
});

describe('review fixes', () => {
  it('unblocks on a blocker that has since been deleted', async () => {
    const { source } = project(
      '- [ ] PAWNEE-2: Volunteer sign-up form\n- [ ] PAWNEE-3: Lot 48 pit photo gallery\n'
    );

    await source.block('PAWNEE-2', 'PAWNEE-3');
    await source.delete('PAWNEE-3', 'Lot 48 is a park now');

    expect(await source.next()).toBeNull();

    await source.unblock('PAWNEE-2', 'PAWNEE-3');

    expect((await source.get('PAWNEE-2')).blockedBy).toEqual([]);
    expect(await source.next()).toMatchObject({ id: 'PAWNEE-2' });
    await expect(source.unblock('PAWNEE-2', '../evil')).rejects.toThrow(
      "isn't a ticket id"
    );
  });

  it.each([['Raise $$ for Lil Sebastian'], ['a $& b'], ["$` and $'"]])(
    'renames to %j exactly, in TASKS.md and the heading',
    async (title) => {
      const { root, source, tasksFile } = project();

      await source.update('PAWNEE-3', { title });

      expect(read(tasksFile)).toContain(`- [ ] PAWNEE-3: ${title}\n`);
      expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
        `# ${title}\n`
      );
    }
  );

  it('leaves TASKS.md alone when the ticket file can’t be written', async () => {
    const { root, source, tasksFile } = project(TASKS, {
      'tickets/PAWNEE-3.md': '# Lot 48 pit photo gallery\n',
    });
    const dir = path.join(root, 'tickets');
    fs.chmodSync(dir, 0o555);

    try {
      await expect(
        source.update('PAWNEE-3', { status: 'blocked', reason: 'Fence' })
      ).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      fs.chmodSync(dir, 0o755);
    }

    expect(read(tasksFile)).toBe(TASKS);
    expect((await source.get('PAWNEE-3')).status).toBe('ready');
  });

  it('an update that changes nothing writes no ticket file', async () => {
    const { root, source, tasksFile } = project();

    await source.update('PAWNEE-3', {});

    expect(read(tasksFile)).toBe(TASKS);
    expect(fs.existsSync(path.join(root, 'tickets'))).toBe(false);
  });

  // A project that hasn't made its first ticket has no queue file yet:
  // nothing to build, not a broken setup. Settings → Design system's Make it
  // lists before it creates, so a refusal here stopped the first ticket.
  it('reads a missing queue file as no tickets yet: list, next and queue are empty', async () => {
    const root = tmp();
    const source = createMarkdownSource(context(root));

    await expect(source.list()).resolves.toEqual([]);
    await expect(source.next()).resolves.toBeNull();
    await expect(source.queue()).resolves.toEqual({
      tickets: [],
      outside: new Map(),
    });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses reading or changing one ticket when tickets.queue names no file, naming it', async () => {
    const { root } = project();
    const source = createMarkdownSource(context(root, { queue: 'TASK.md' }));
    const missing = `tickets.queue "TASK.md" names no file: ${path.join(
      root,
      'TASK.md'
    )} doesn't exist.`;

    await expect(source.list()).rejects.toThrow(missing);
    await expect(source.next()).rejects.toThrow(missing);
    await expect(source.get('PAWNEE-1')).rejects.toThrow(missing);
    await expect(source.update('PAWNEE-1', { status: 'done' })).rejects.toThrow(
      missing
    );
    await expect(source.block('PAWNEE-2', 'PAWNEE-1')).rejects.toThrow(missing);
    expect(fs.readdirSync(root)).toEqual(['TASKS.md']);
  });

  it('create starts a queue file that is not there yet', async () => {
    const root = tmp();
    const source = createMarkdownSource(context(root));

    expect((await source.create({ title: 'Harvest festival' })).id).toBe(
      'PAWNEE-1'
    );
    expect(read(path.join(root, 'TASKS.md'))).toBe(
      '- [ ] PAWNEE-1: Harvest festival\n'
    );
  });

  it('keeps a byte order mark at the start of TASKS.md only', async () => {
    const bom = `﻿${TASKS.replace('# Pawnee Parks app\n\n', '')}`;
    const { source, tasksFile } = project(bom);

    expect((await source.list()).map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-1a',
      'PAWNEE-1b',
      'PAWNEE-2',
      'PAWNEE-3',
    ]);
    await source.create({ title: 'Harvest festival' });

    const created = read(tasksFile);

    expect(created).toBe(`${bom}- [ ] PAWNEE-4: Harvest festival\n`);
    expect(created.split('﻿')).toHaveLength(2);

    await source.delete('PAWNEE-4', 'Moved to next year');

    expect(fs.readFileSync(tasksFile)).toEqual(Buffer.from(bom, 'utf8'));
  });

  it('refuses to create over an orphan ticket file', async () => {
    const orphan = '# Something else entirely\n';
    const { root, source, tasksFile } = project(TASKS, {
      'tickets/PAWNEE-4.md': orphan,
    });

    await expect(source.create({ title: 'Harvest festival' })).rejects.toThrow(
      `${path.join(
        'tickets',
        'PAWNEE-4.md'
      )} already exists, but PAWNEE-4 isn't in the queue; move that file away, then create again.`
    );
    expect(read(path.join(root, 'tickets', 'PAWNEE-4.md'))).toBe(orphan);
    expect(read(tasksFile)).toBe(TASKS);
  });
});

describe('one writer at a time', () => {
  const lockOf = (root: string): string => path.join(root, '.TASKS.md.lock');
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('waits for a held queue lock, then writes', async () => {
    const { root, source, tasksFile } = project();
    write(lockOf(root), '');

    const created = source.create({ title: 'Harvest festival' });
    await pause(300);

    expect(read(tasksFile)).toBe(TASKS);
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-4.md'))).toBe(
      false
    );

    fs.rmSync(lockOf(root));

    expect((await created).id).toBe('PAWNEE-4');
    expect(fs.existsSync(lockOf(root))).toBe(false);
  });

  it('gives up on a lock that stays held, naming it, and writes nothing', async () => {
    const { root, tasksFile } = project();
    const source = createMarkdownSource(context(root), {
      waitMs: 200,
      staleMs: 60_000,
      retryMs: 20,
    });
    write(lockOf(root), '');

    await expect(source.update('PAWNEE-3', { status: 'done' })).rejects.toThrow(
      `Another lambda is writing the queue (${lockOf(
        root
      )} is held); try again, or delete that file if nothing else is running.`
    );
    expect(read(tasksFile)).toBe(TASKS);
    expect(fs.existsSync(lockOf(root))).toBe(true);
  });

  it('clears a stale lock', async () => {
    const { root, source } = project();
    write(lockOf(root), '');
    const longAgo = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockOf(root), longAgo, longAgo);

    expect((await source.create({ title: 'Harvest festival' })).id).toBe(
      'PAWNEE-4'
    );
    expect(fs.existsSync(lockOf(root))).toBe(false);
  });

  it('never clears a fresh lock it saw as stale a moment before', async () => {
    // Two writers find the same stale lock; the first clears it and takes a
    // fresh one. The second's look at the lock is from before that.
    const { root, tasksFile } = project();
    const source = createMarkdownSource(context(root), {
      waitMs: 200,
      staleMs: 60_000,
      retryMs: 20,
    });
    write(lockOf(root), 'the first writer');
    const { statSync } = realFs;
    const looks = jest.spyOn(realFs, 'statSync');
    looks.mockImplementationOnce((file) =>
      Object.assign(statSync(file), { mtimeMs: Date.now() - 10 * 60_000 })
    );

    await expect(source.create({ title: 'Harvest festival' })).rejects.toThrow(
      'Another lambda is writing the queue'
    );
    looks.mockRestore();
    expect(read(lockOf(root))).toBe('the first writer');
    expect(read(tasksFile)).toBe(TASKS);
  });

  it("leaves a lock alone on release once it isn't this writer's", async () => {
    // This writer's lock was cleared as stale and another writer took it.
    const { root, source } = project();
    const { renameSync } = realFs;
    const renames = jest.spyOn(realFs, 'renameSync');
    renames.mockImplementationOnce((from, to) => {
      realFs.writeFileSync(lockOf(root), 'the next writer');
      renameSync(from, to);
    });

    await source.update('PAWNEE-3', { status: 'done' });
    renames.mockRestore();

    expect(read(lockOf(root))).toBe('the next writer');
  });

  it('releases the lock when a change is refused', async () => {
    const { root, source } = project();

    await expect(source.delete('PAWNEE-1', 'No')).rejects.toThrow(
      'still has children'
    );
    expect(fs.existsSync(lockOf(root))).toBe(false);
  });

  it('gives racing processes distinct ids and keeps every line', async () => {
    const { root, tasksFile } = project();
    const scripts = tmp();
    const script = path.join(scripts, 'create.ts');
    write(
      script,
      [
        `import { createMarkdownSource } from ${JSON.stringify(
          path.join(__dirname, '..', 'markdown')
        )};`,
        'const [root, title, start] = process.argv.slice(2);',
        'const wait = Number(start) - Date.now();',
        'setTimeout(() => {',
        "  createMarkdownSource({ root, config: { source: 'markdown', prefix: 'PAWNEE' }, tokens: undefined, env: {}, fetch, runner: null })",
        '    .create({ title })',
        '    .then((ticket) => console.log(ticket.id));',
        '}, Math.max(0, wait));',
      ].join('\n')
    );
    const tsx = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'node_modules',
      '.bin',
      'tsx'
    );
    const start = String(Date.now() + 2500);
    const titles = ['Harvest festival', 'Ice Town', 'Lil Sebastian', 'Lot 48'];
    const ids = await Promise.all(
      titles.map(
        (title) =>
          new Promise<string>((resolve, reject) => {
            execFile(tsx, [script, root, title, start], (error, stdout) =>
              error === null ? resolve(stdout.trim()) : reject(error)
            );
          })
      )
    );

    expect([...ids].sort()).toEqual([
      'PAWNEE-4',
      'PAWNEE-5',
      'PAWNEE-6',
      'PAWNEE-7',
    ]);
    const queue = read(tasksFile);
    titles.forEach((title, index) => {
      expect(queue).toContain(`: ${title}\n`);
      expect(
        read(path.join(root, 'tickets', `${ids[index] ?? ''}.md`))
      ).toContain(`# ${title}\n`);
    });
  }, 30_000);
});

describe('input that would break a line', () => {
  it('refuses a title that spans lines, so it cannot add a ticket of its own', async () => {
    const { root, source, tasksFile } = project();

    await expect(
      source.create({ title: 'Real title\n- [x] PAWNEE-99: Fake' })
    ).rejects.toThrow("title can't span lines.");
    await expect(
      source.update('PAWNEE-3', { title: 'Lot 48\r\npit' })
    ).rejects.toThrow("title can't span lines.");
    expect(read(tasksFile)).toBe(TASKS);
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-4.md'))).toBe(
      false
    );
    expect((await source.list()).map((ticket) => ticket.id)).not.toContain(
      'PAWNEE-99'
    );
  });

  it('refuses a block reason that spans lines', async () => {
    const { root, source, tasksFile } = project();

    await expect(
      source.update('PAWNEE-3', {
        status: 'blocked',
        reason: "Waiting on Ann.\nShe's back Monday.",
      })
    ).rejects.toThrow("reason can't span lines.");
    expect(read(tasksFile)).toBe(TASKS);
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
      false
    );
  });

  it('refuses a label holding a line break, a comma or a closing bracket', async () => {
    const { root, source } = project();

    await expect(
      source.update('PAWNEE-3', { labels: ['planned\nstatus: done'] })
    ).rejects.toThrow('label "planned\\nstatus: done" can\'t span lines.');
    await expect(
      source.update('PAWNEE-3', { labels: ['parks,rec'] })
    ).rejects.toThrow('label "parks,rec" can\'t hold "," or "]".');
    await expect(
      source.update('PAWNEE-3', { labels: ['parks]'] })
    ).rejects.toThrow('label "parks]" can\'t hold "," or "]".');
    expect(fs.existsSync(path.join(root, 'tickets', 'PAWNEE-3.md'))).toBe(
      false
    );
  });
});

describe('a ticket id written twice in TASKS.md', () => {
  const tasks = [
    '- [ ] PAWNEE-1: Park map page',
    '  - [ ] PAWNEE-1a: Map tiles',
    '  - [ ] PAWNEE-1b: Pins for each park',
    '  - [ ] PAWNEE-1a: Map tiles again',
    '- [ ] PAWNEE-4: Harvest festival',
    '- [ ] PAWNEE-4: Harvest festival, from the other branch',
    '',
  ].join('\n');

  it('is refused on read, naming both lines', async () => {
    const { source } = project(tasks);

    await expect(source.list()).rejects.toThrow(
      'TASKS.md:4: PAWNEE-1a is already on line 2.'
    );
  });

  it('is refused by place and reorder, which write nothing', async () => {
    const { source, tasksFile } = project(tasks);

    await expect(source.place(['PAWNEE-1'], 'PAWNEE-4')).rejects.toThrow(
      'TASKS.md:4: PAWNEE-1a is already on line 2.'
    );
    await expect(
      source.reorder('PAWNEE-1', ['PAWNEE-1b', 'PAWNEE-1a'])
    ).rejects.toThrow('TASKS.md:4: PAWNEE-1a is already on line 2.');
    expect(read(tasksFile)).toBe(tasks);
  });
});

describe('a TASKS.md with mixed line endings', () => {
  const mixed = [
    '- [ ] PAWNEE-1: Park map page\r\n',
    '- [ ] PAWNEE-2: Volunteer sign-up form\n',
    '- [ ] PAWNEE-3: Lot 48 pit photo gallery\r\n',
    '- [ ] PAWNEE-4: Harvest festival',
  ].join('');

  it('lists every ticket', async () => {
    const { source } = project(mixed);

    expect((await source.list()).map((ticket) => ticket.id)).toEqual([
      'PAWNEE-1',
      'PAWNEE-2',
      'PAWNEE-3',
      'PAWNEE-4',
    ]);
  });

  it("keeps each line's own ending through an update, a create and a place", async () => {
    const { source, tasksFile } = project(mixed);

    await source.update('PAWNEE-2', { status: 'done' });

    expect(read(tasksFile)).toBe(mixed.replace('[ ] PAWNEE-2', '[x] PAWNEE-2'));

    await source.place(['PAWNEE-4'], 'PAWNEE-1');

    expect(read(tasksFile)).toBe(
      [
        '- [ ] PAWNEE-1: Park map page\r\n',
        '- [ ] PAWNEE-4: Harvest festival\r\n',
        '- [x] PAWNEE-2: Volunteer sign-up form\n',
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
      ].join('')
    );

    await source.create({ title: 'Pawnee Commons' });

    expect(read(tasksFile)).toBe(
      [
        '- [ ] PAWNEE-1: Park map page\r\n',
        '- [ ] PAWNEE-4: Harvest festival\r\n',
        '- [x] PAWNEE-2: Volunteer sign-up form\n',
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery\r\n',
        '- [ ] PAWNEE-5: Pawnee Commons',
      ].join('')
    );
  });
});

describe('priority, the computer it is assigned to, and editing', () => {
  it('reads and writes priority and computer in the front matter, leaving TASKS.md alone', async () => {
    const { root, source, tasksFile } = project();
    const before = read(tasksFile);

    await source.update('PAWNEE-3', {
      priority: 'high',
      assignee: "Leslie's MacBook Pro",
    });

    const ticket = await source.get('PAWNEE-3');
    expect(ticket.priority).toBe('high');
    expect(ticket.assignee).toBe("Leslie's MacBook Pro");
    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toContain(
      "priority: high\nassignee: Leslie's MacBook Pro"
    );
    expect(read(tasksFile)).toBe(before);

    // None and unassigned take the keys out again.
    await source.update('PAWNEE-3', { priority: 'none', assignee: null });
    const cleared = read(path.join(root, 'tickets', 'PAWNEE-3.md'));
    expect(cleared).not.toContain('priority:');
    expect(cleared).not.toContain('assignee:');
  });

  it("keeps a known computer's id beside its name, so a rename keeps its tickets", async () => {
    const { root } = project();
    const home = tmp();
    const env = { LAMBDA_HOME: home };
    const known = (name: string) =>
      writeKnownAssignees(
        { linear: {}, jira: {}, computers: { rnr_ann: name } },
        env
      );
    const source = createMarkdownSource({ ...context(root), env });
    known("Ann's Mac mini");

    // Assigned the way macOS writes the name: the id is found all the same.
    await source.update('PAWNEE-3', { assignee: 'Ann\u2019s Mac mini' });
    expect(read(path.join(root, 'tickets', 'PAWNEE-3.md'))).toContain(
      'assignee: Ann\u2019s Mac mini\nassignee-id: rnr_ann'
    );

    known('Ann\u2019s office Mac');
    expect((await source.get('PAWNEE-3')).assignee).toBe(
      'Ann\u2019s office Mac'
    );

    // A person, or a computer Lambda doesn't know, is only a name.
    await source.update('PAWNEE-3', { assignee: 'Leslie Knope' });
    const byHand = read(path.join(root, 'tickets', 'PAWNEE-3.md'));
    expect(byHand).toContain('assignee: Leslie Knope');
    expect(byHand).not.toContain('assignee-id:');
  });

  it('reads a priority it does not know as none', async () => {
    const { source } = project(TASKS, {
      'tickets/PAWNEE-3.md': '---\npriority: someday\n---\n# Lot 48\n',
    });

    expect((await source.get('PAWNEE-3')).priority).toBe('none');
  });

  it('creates a ticket with priority, computer and labels', async () => {
    const { source } = project();
    const created = await source.create({
      title: 'Harvest festival schedule',
      priority: 'urgent',
      assignee: "Ann's Mac mini",
      labels: ['site'],
    });

    expect(created).toMatchObject({
      priority: 'urgent',
      assignee: "Ann's Mac mini",
      labels: ['site'],
      status: 'inbox',
    });
  });

  it('replaces the description under the title, and takes labels off', async () => {
    const { source } = project(TASKS, {
      'tickets/PAWNEE-3.md':
        '---\nlabels: [site, bug]\n---\n# Lot 48 pit photo gallery\n\nOld words.\n',
    });

    await source.update('PAWNEE-3', {
      description: 'Photos of the pit, newest first.',
      removeLabels: ['bug'],
    });

    const ticket = await source.get('PAWNEE-3');
    expect(ticket.description).toBe('Photos of the pit, newest first.');
    expect(ticket.title).toBe('Lot 48 pit photo gallery');
    expect(ticket.labels).toEqual(['site']);
  });
});

describe('moving a ticket to another epic', () => {
  it('moves its block under the new parent, indented to match, and back out', async () => {
    const { source, tasksFile } = project(
      [
        '- [ ] PAWNEE-1: Park map page',
        '  - [x] PAWNEE-1a: Map tiles',
        '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
        '    A note under it.',
        '- [ ] PAWNEE-4: Contact page',
        '',
      ].join('\n')
    );

    await source.update('PAWNEE-3', { parent: 'PAWNEE-1' });

    expect(read(tasksFile)).toBe(
      [
        '- [ ] PAWNEE-1: Park map page',
        '  - [x] PAWNEE-1a: Map tiles',
        '  - [ ] PAWNEE-3: Lot 48 pit photo gallery',
        '      A note under it.',
        '- [ ] PAWNEE-4: Contact page',
        '',
      ].join('\n')
    );
    expect((await source.get('PAWNEE-3')).parent).toBe('PAWNEE-1');

    await source.update('PAWNEE-3', { parent: null });

    expect((await source.get('PAWNEE-3')).parent).toBeNull();
    expect(read(tasksFile).split('\n').slice(-3)).toEqual([
      '- [ ] PAWNEE-3: Lot 48 pit photo gallery',
      '    A note under it.',
      '',
    ]);
  });

  it('refuses to move a ticket under its own child', async () => {
    const { source } = project();

    await expect(
      source.update('PAWNEE-1', { parent: 'PAWNEE-1b' })
    ).rejects.toThrow('its own children');
  });
});

describe('when a ticket last changed', () => {
  it('reads its file’s time, and none for a ticket with no file', async () => {
    const { source } = project(TASKS, {
      'tickets/PAWNEE-3.md': '---\npriority: low\n---\n# Lot 48\n',
    });
    const tickets = await source.list();

    expect(
      Number.isFinite(
        Date.parse(
          tickets.find((one) => one.id === 'PAWNEE-3')?.updatedAt ?? ''
        )
      )
    ).toBe(true);
    expect(tickets.find((one) => one.id === 'PAWNEE-1')?.updatedAt).toBeNull();
  });
});

describe('a ticket assigned to a person', () => {
  it('reads an old computer: key, and writes assignee: in its place', async () => {
    const { root, source } = project(TASKS, {
      'tickets/PAWNEE-3.md': "---\ncomputer: Ann's Mac mini\n---\n# Lot 48\n",
    });

    expect((await source.get('PAWNEE-3')).assignee).toBe("Ann's Mac mini");

    await source.update('PAWNEE-3', { assignee: 'Leslie Knope' });

    const file = read(path.join(root, 'tickets', 'PAWNEE-3.md'));
    expect(file).toContain('assignee: Leslie Knope');
    expect(file).not.toContain('computer:');
  });
});
