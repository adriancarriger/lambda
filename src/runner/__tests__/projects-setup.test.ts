import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { LAMBDA_GITIGNORE_LINES } from '../../commands/init';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  startHarness,
  tempHome,
} from '../../mothership/__tests__/harness';
import { HOST_RUNNER_SECRET } from '../../mothership/server';
import { addProject, folderSlug, newProject } from '../projectsSetup';

describe('Add a project and New project', () => {
  const fixture: {
    harness?: Harness;
    runner?: FakeRunner;
    home?: string;
    cookie?: string;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const home = (): string => required(fixture.home, 'home');
  const cookie = (): string => required(fixture.cookie, 'cookie');
  const env = () => ({
    ...process.env,
    LAMBDA_HOME: path.join(home(), '.lambda'),
  });

  beforeEach(async () => {
    fixture.home = tempHome();
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness(), {
      name: "Leslie's MacBook",
    });
    await runner().next('owner');
    harness()
      .db.prepare('INSERT INTO secrets (name, value) VALUES (?, ?)')
      .run(HOST_RUNNER_SECRET, runner().runnerId);
    // The host runner's half, as runtime.ts answers these.
    runner().on('project-add', (message) =>
      addProject({
        typed: String(message.folder),
        known: Array.isArray(message.known) ? message.known : [],
        computer: "Leslie's MacBook",
        home: home(),
        env: env(),
      })
    );
    runner().on('project-new', (message) =>
      newProject({ name: String(message.name), home: home() })
    );
    runner().on('pod-new', () => 'first-plan');
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
    fs.rmSync(home(), { recursive: true, force: true });
  });

  const add = (folder: string) =>
    harness().request('POST', '/api/projects/add', {
      cookie: cookie(),
      body: JSON.stringify({ folder }),
    });
  const rows = () => ({
    projects: harness()
      .db.prepare<
        [],
        {
          n: number;
        }
      >('SELECT COUNT(*) AS n FROM projects')
      .get()?.n,
    links: harness()
      .db.prepare<
        [],
        {
          n: number;
        }
      >('SELECT COUNT(*) AS n FROM runner_projects')
      .get()?.n,
  });

  it('sets up a folder with no git and no lambda.json, quietly', async () => {
    const folder = path.join(home(), 'pawnee-parks');
    fs.mkdirSync(folder);

    const response = await add(folder);

    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'lambda.json'))).toBe(true);
    expect(rows()).toEqual({ projects: 1, links: 1 });
  });

  it('registers a folder that has a lambda.json as it is', async () => {
    const folder = path.join(home(), 'sweetums');
    fs.mkdirSync(folder);
    const json = '{ "name": "Sweetums recipe app" }\n';
    fs.writeFileSync(path.join(folder, 'lambda.json'), json);

    const response = await add(folder);

    expect(response.status).toBe(200);
    expect(fs.readFileSync(path.join(folder, 'lambda.json'), 'utf8')).toBe(
      json
    );
    expect(harness().db.prepare('SELECT name FROM projects').all()).toEqual([
      { name: 'Sweetums recipe app' },
    ]);
  });

  it('refuses a missing folder and one already added, adding no row', async () => {
    const folder = path.join(home(), 'pawnee-parks');
    fs.mkdirSync(folder);
    await add(folder);

    const missing = await add(path.join(home(), 'nope'));
    const again = await add(folder);

    expect(missing.status).toBe(400);
    expect(missing.json().error).toBe(
      `There's no folder at ${path.join(home(), 'nope')} on Leslie's MacBook.`
    );
    expect(again.json().error).toBe(`${folder} is already a codebase.`);
    expect(rows()).toEqual({ projects: 1, links: 1 });
  });

  it('makes a new project with a starter whose one test passes, and its first plan', async () => {
    const make = () =>
      harness().request('POST', '/api/projects/new', {
        cookie: cookie(),
        body: JSON.stringify({
          name: 'Sweetums recipe app',
          idea: 'Track every nougat batch',
        }),
      });

    const first = await make();
    const folder = path.join(home(), 'Lambda', 'sweetums-recipe-app');

    expect(first.status).toBe(200);
    // The computer isn't on the new project yet: the plan waits for its idle
    // switch, which (nothing running) starts it at once.
    expect(first.json<{ result: { podId: string } }>().result.podId).toMatch(
      /^waiting:/
    );
    await eventually(() =>
      runner().received.some((message) => message.type === 'pod-new')
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(folder, 'lambda.json'), 'utf8'))
    ).toMatchObject({
      name: 'Sweetums recipe app',
      app: { start: 'node server.mjs' },
      commands: { test: 'node --test' },
    });
    expect(fs.existsSync(path.join(folder, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(true);
    expect(
      runner().received.find((message) => message.type === 'pod-new')
    ).toMatchObject({
      // Its first planning pod: the pipeline, not a freeform chat.
      intake: { text: 'Track every nougat batch', freeform: false },
    });
    // The starter's own test, as the project would run it.
    expect(() =>
      execFileSync(process.execPath, ['--test'], { cwd: folder, stdio: 'pipe' })
    ).not.toThrow();

    const second = await make();

    expect(second.status).toBe(400);
    expect(second.json().error).toBe(
      '~/Lambda/sweetums-recipe-app already exists. Pick another name.'
    );
  });

  it('gives a new project the .lambda/.gitignore init writes, in its first commit', () => {
    const { folder } = newProject({
      name: 'Sweetums recipe app',
      home: home(),
    });

    expect(
      fs.readFileSync(path.join(folder, '.lambda', '.gitignore'), 'utf8')
    ).toBe(`${LAMBDA_GITIGNORE_LINES.join('\n')}\n`);
    expect(
      execFileSync('git', ['ls-files'], { cwd: folder, encoding: 'utf8' })
    ).toContain('.lambda/.gitignore');
  });

  it('names the folder from the project, lowercase and hyphenated', () => {
    expect(folderSlug('Sweetums recipe app')).toBe('sweetums-recipe-app');
    expect(folderSlug("Leslie's  Big   Idea!")).toBe('leslie-s-big-idea');
  });

  it("says the host's computer is offline", async () => {
    await runner().close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await add(home());

    expect(response.status).toBe(409);
    expect(response.json().error).toBe("Leslie's MacBook is offline.");
  });
});
