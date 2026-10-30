import * as fs from 'fs';
import * as path from 'path';

import type { MachineConfig } from '../../config/machineConfig';
import {
  type Harness,
  eventually,
  holdProject,
  startHarness,
} from '../../mothership/__tests__/harness';
import { addRunner } from '../../mothership/registry';
import { LAMBDA_HOME } from '../../pod/__tests__/podProject';
import { generateRunnerKeys } from '../../runner/keys';
import { writeRunnerState } from '../../runner/localFiles';
import { createRunnerProcess } from '../../runner/process';
import { buildingPodStore, fakeSource, ticket } from './fakes';

/**
 * Whose tickets a computer builds comes from the mothership's `owner`
 * message, through the runner's real wiring: its socket, its runtime, its
 * pick-up. Whatever this computer's own ~/.lambda/config.json says (Ron as
 * owner, or no owner at all), only Leslie's tickets are taken: her email,
 * and her aliases, including one added later and pushed in a second
 * `owner` message.
 */

const RUNNER = 'rnr_leslie_mac';
const LESLIE = { name: 'Leslie Knope', email: 'leslie@pawnee.gov' };
const RON = { name: 'Ron Swanson', email: 'ron@pawnee.gov' };
const T0 = Date.parse('2026-10-23T10:00:00.000Z');

const state: {
  harness: Harness | null;
  stop: (() => void) | null;
} = { harness: null, stop: null };

afterEach(async () => {
  state.stop?.();
  await state.harness?.close();
});

describe.each<[string, MachineConfig]>([
  ['names Ron as the owner', { owner: RON }],
  ['names no owner at all', {}],
])('a runner whose own config %s', (_how, runnerConfig) => {
  it("builds for the mothership's owner, her aliases included", async () => {
    const harness = await startHarness({ config: { owner: LESLIE } });
    state.harness = harness;
    const alias = (value: string) =>
      harness.db
        .prepare(
          'INSERT INTO aliases (kind, value, created_at) VALUES (?, ?, ?)'
        )
        .run('email', value, harness.clock.now);
    alias('lknope@pawnee.gov');
    const keys = generateRunnerKeys();
    addRunner(
      harness.db,
      { id: RUNNER, name: "Leslie's Mac", publicKey: keys.publicKey },
      harness.clock.now
    );
    const { store, root, podId } = buildingPodStore('build-a1b2', RUNNER);
    fs.writeFileSync(
      path.join(root, 'lambda.json'),
      `${JSON.stringify({ name: 'Pawnee Parks app' })}\n`
    );
    holdProject(harness, RUNNER, { name: 'Pawnee Parks app', folder: root });
    const env = {
      ...process.env,
      LAMBDA_HOME,
      LAMBDA_URL: `http://127.0.0.1:${harness.port}`,
    };
    writeRunnerState({ current: root }, env);
    const source = fakeSource([
      ticket('1', { reporter: RON }),
      ticket('2', { reporter: LESLIE }),
      ticket('3', { reporter: { name: 'Bot', email: 'lknope@pawnee.gov' } }),
      ticket('4', { reporter: { name: 'Bot', email: 'knope@pawnee.gov' } }),
    ]);
    const clock = { now: T0 };
    const ran: string[][] = [];
    const logged: string[] = [];
    const runner = createRunnerProcess({
      config: runnerConfig,
      runnerId: RUNNER,
      privateKey: keys.privateKey,
      log: (line) => logged.splice(logged.length, 0, line),
      env,
      // The fakes reach every part, building pods' pick-up included: no real
      // `lambda` or tmux runs.
      lambda: {
        run: async (args) => {
          ran.splice(ran.length, 0, args);

          return '';
        },
        spawn: () => {
          throw new Error('No pod is started in this test.');
        },
      },
      tmux: () => '',
      buildingSource: () => source,
      now: () => clock.now,
    });
    state.stop = () => {
      runner.client.stop();
      runner.runtime.dispose();
    };
    const taken = () => store.readBuilding(podId).runs.map((run) => run.id);
    /** `lambda ship` stamps the current run, as a pod's ship would. */
    const shipCurrent = () =>
      store.updateBuilding(podId, (building) => ({
        ...building,
        runs: building.runs.map((run) => ({
          ...run,
          shippedAt: run.shippedAt ?? new Date(clock.now).toISOString(),
        })),
      }));

    runner.client.start();
    await eventually(() => runner.runtime.hosts.size === 1);

    await runner.runtime.tickBuilding();
    shipCurrent();
    await runner.runtime.tickBuilding();
    shipCurrent();
    await runner.runtime.tickBuilding();

    // Her email, then her alias; never Ron's, not yet knope@.
    expect(taken()).toEqual(['2', '3']);
    // What's left is someone else's, and the idle line says so.
    expect(store.readBuilding(podId).idleReason).toBe(
      'Skipping 1, 4: Ready, but reported by ron@pawnee.gov, knope@pawnee.gov, and Lambda builds only tickets you report. If one of them is you, add it with lambda account alias add'
    );

    // A new alias: the mothership's next tick sends the owner again.
    alias('knope@pawnee.gov');
    await harness.mothership.tick();
    // The owner message travels the socket: a few polls (each 60 s apart on
    // the runner's clock), bounded.
    const pollUntilTaken = async (triesLeft: number): Promise<void> => {
      clock.now += 60_000;
      await runner.runtime.tickBuilding();

      if (taken().includes('4') || triesLeft === 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      await pollUntilTaken(triesLeft - 1);
    };
    await pollUntilTaken(20);

    expect(taken()).toEqual(['2', '3', '4']);
    expect(source.statusOf('1')).toBe('ready');
    expect(
      ran.filter(
        (args) =>
          args[0] === 'pod' &&
          args[1] === 'send' &&
          args[2] === podId &&
          args[3] === 'engineering-manager'
      )
    ).toHaveLength(3);
    // Nothing went wrong on the way: the socket's own line is all it said.
    expect(logged.filter((line) => line !== 'Connected.')).toEqual([]);
  });
});
