import * as fs from 'fs';
import * as path from 'path';

import { realStartDeps } from '..';
import { required } from '../../../__tests__/required';
import {
  loadMachineConfig,
  writeMachineConfig,
} from '../../../config/machineConfig';
import { loadProjectConfig } from '../../../config/projectConfig';
import {
  type Harness,
  startHarness,
  tempHome,
} from '../../../mothership/__tests__/harness';
import { addRunner, newRunnerId } from '../../../mothership/registry';
import { createRunnerClient } from '../../../runner/client';
import { generateRunnerKeys } from '../../../runner/keys';
import { writeRunnerState } from '../../../runner/localFiles';
import { createOutbox } from '../../../runner/outbox';
import type { PodHost } from '../../../runner/podHost';
import { createRuntime } from '../../../runner/runtime';

/** A pod host with no pods: linking needs none. */
const notInThisTest = (what: string): Error =>
  new Error(`${what} isn't used by linking.`);

const emptyHost = (folder: string): PodHost => ({
  folder,
  get store(): PodHost['store'] {
    throw notInThisTest('store');
  },
  snapshots: () => ({
    pods: [],
    tts: {
      queue: { queued: 0, pods: 0 },
      enabled: false,
      overBudget: false,
      usd: 0,
      capUsd: 0,
      renderCharsPerSecond: null,
    },
  }),
  handle: () => Promise.reject(notInThisTest('handle')),
  newPod: () => Promise.reject(notInThisTest('newPod')),
  termRead: () => {
    throw notInThisTest('termRead');
  },
  termKeys: () => {
    throw notInThisTest('termKeys');
  },
  podFile: () => {
    throw notInThisTest('podFile');
  },
  worktrees: () => [],
  dispose: () => undefined,
});

const writeProject = (folder: string) =>
  fs.writeFileSync(
    path.join(folder, 'lambda.json'),
    JSON.stringify({ name: 'Pawnee Parks site' })
  );

describe('lambda start links the folder', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const made: { folders: string[] } = { folders: [] };

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(async () => {
    await harness().close();
    const done = made.folders;
    made.folders = [];
    done.forEach((folder) =>
      fs.rmSync(folder, { recursive: true, force: true })
    );
  });

  const folder = (): string => {
    const home = tempHome();
    made.folders = [...made.folders, home];
    writeProject(home);

    return home;
  };

  const counts = () => ({
    projects: harness().db.prepare('SELECT name FROM projects').all(),
    links: harness()
      .db.prepare<
        [],
        {
          n: number;
        }
      >('SELECT COUNT(*) AS n FROM runner_projects')
      .get()?.n,
  });

  it('one project, one row per computer, nothing new on a second start', async () => {
    // The host writes through the database file.
    const hostEnv = { LAMBDA_HOME: harness().home };
    writeMachineConfig({ owner: { name: 'Leslie Knope' } }, hostEnv);
    const hostFolder = folder();
    const project = loadProjectConfig(hostFolder);

    if (project === null) {
      throw new Error('no project');
    }

    realStartDeps(hostEnv).linkOnHost(project);

    // A joined computer, its own checkout, the same name: a project-link.
    const keys = generateRunnerKeys();
    const runnerId = newRunnerId();
    addRunner(
      harness().db,
      { id: runnerId, name: "Leslie's Mac mini", publicKey: keys.publicKey },
      1
    );
    const joinedHome = tempHome();
    made.folders = [...made.folders, joinedHome];
    const joinedEnv = { LAMBDA_HOME: joinedHome };
    const joinedFolder = folder();
    writeRunnerState({ current: joinedFolder }, joinedEnv);
    const holder: { connected: () => void } = { connected: () => undefined };
    const connected = new Promise<void>((resolve) => {
      holder.connected = resolve;
    });
    const client = createRunnerClient({
      url: `http://127.0.0.1:${harness().port}`,
      runnerId,
      privateKey: keys.privateKey,
      outbox: createOutbox(path.join(joinedHome, 'outbox.jsonl')),
      handle: async () => null,
      onConnected: (value) => value && holder.connected(),
      log: () => undefined,
    });
    const runtime = createRuntime({
      runnerId,
      computer: "Leslie's Mac mini",
      client: () => client,
      makeHost: emptyHost,
      startDeps: () => realStartDeps(joinedEnv),
      log: () => undefined,
      env: joinedEnv,
    });
    client.start();
    await connected;

    await runtime.linkCurrent();

    expect(counts()).toEqual({
      projects: [{ name: 'Pawnee Parks site' }],
      links: 2,
    });

    await runtime.linkCurrent();

    expect(counts()).toEqual({
      projects: [{ name: 'Pawnee Parks site' }],
      links: 2,
    });

    // One row per computer, each with its own checkout.
    const hostRunner = loadMachineConfig(hostEnv)?.runner?.id;
    expect(
      harness()
        .db.prepare<[], { runner_id: string; folder: string }>(
          'SELECT runner_id, folder FROM runner_projects ORDER BY folder'
        )
        .all()
        .sort((a, b) => a.runner_id.localeCompare(b.runner_id))
    ).toEqual(
      [
        { runner_id: hostRunner, folder: hostFolder },
        { runner_id: runnerId, folder: joinedFolder },
      ].sort((a, b) => String(a.runner_id).localeCompare(String(b.runner_id)))
    );
    client.stop();
  });
});
