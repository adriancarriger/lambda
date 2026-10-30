import * as fs from 'fs';
import * as path from 'path';

import { SETUP_DONE, machineHome } from '../../__tests__/machineHome';
import type { PodIntake } from '../../app/shared/snapshot';
import type { StartDeps } from '../../commands/start';
import { tempHome } from '../../mothership/__tests__/harness';
import { randomId } from '../../mothership/crypto';
import type { WhoAmI } from '../../tickets/whoAmI';
import type { RunnerClient } from '../client';
import {
  readKnownAssignees,
  readRunnerState,
  writeRunnerState,
} from '../localFiles';
import type { PodHost } from '../podHost';
import type { Processes } from '../processes';
import { createRuntime } from '../runtime';
import type { TicketRequests } from '../ticketRequests';

/**
 * The idle switch as the runner really runs it: a `pod-new` for another
 * project's folder goes through runtime → runSwitch → `lambda stop` on the
 * old folder → `lambda start` on the new one (which ends with
 * `lambda pod resume-all`) → `lambda pod new` with the waiting intake.
 */
/** A runtime on Pawnee Parks site, with Sweetums recipe app also held. */
const setup = (
  overrides: {
    holdStart?: () => Promise<void>;
    now?: () => number;
    building?: () => {
      project: string;
      podsRoot: string;
      podId: string;
    } | null;
    whoAmI?: () => Promise<WhoAmI>;
  } = {}
) => {
  const home = tempHome();
  const pawnee = tempHome();
  const sweetums = tempHome();
  fs.writeFileSync(
    path.join(pawnee, 'lambda.json'),
    '{"name":"Pawnee Parks site"}'
  );
  fs.writeFileSync(
    path.join(sweetums, 'lambda.json'),
    '{"name":"Sweetums recipe app"}'
  );
  const env = { LAMBDA_HOME: home };
  writeRunnerState({ current: pawnee }, env);
  const calls: { log: string[]; disposed: string[]; arrivals: unknown[] } = {
    log: [],
    disposed: [],
    arrivals: [],
  };
  const record = (line: string): void => {
    calls.log = [...calls.log, line];
  };

  const processes: Processes = {
    isRunning: () => true,
    start: () => undefined,
    stop: () => undefined,
    service: {
      file: '',
      installed: () => false,
      install: () => undefined,
      remove: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    },
  };
  const startDeps = (): StartDeps => ({
    env: machineHome(SETUP_DONE),
    tmux: () => '',
    processes,
    hostsMothership: false,
    linkOnHost: () => undefined,
    writeCurrent: () => undefined,
    clearCurrent: () => undefined,
    waitForMothership: async () => null,
    waitForConnected: async () => true,
    resumeAll: async (folder) => {
      await overrides.holdStart?.();
      record(`resume-all ${folder}`);
    },
    runShell: async () => undefined,
    print: (line) => record(line),
    port: 4580,
    startedFile: path.join(home, 'started-windows.json'),
  });
  const host = (folder: string): PodHost => ({
    folder,
    get store(): PodHost['store'] {
      throw new Error('not used');
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
    handle: () => Promise.reject(new Error('not used')),
    newPod: async (intake: PodIntake, projectId?: string) => {
      record(`new ${folder} ${intake.text} ${String(projectId)}`);

      return 'nougat-tracker';
    },
    termRead: () => {
      throw new Error('not used');
    },
    termKeys: () => {
      throw new Error('not used');
    },
    podFile: () => null,
    worktrees: () => [],
    dispose: () => {
      calls.disposed = [...calls.disposed, folder];
    },
  });
  const client: RunnerClient = {
    start: () => undefined,
    stop: () => undefined,
    isConnected: () => false,
    enqueue: (item) => {
      if (item.type === 'tracker-identity') {
        record(`tracker-identity ${JSON.stringify(item.identities)}`);
      }

      if (item.type === 'runner-state') {
        record(`runner-state ${String(item.folder)} ${String(item.switching)}`);
        calls.arrivals = [...calls.arrivals, item.arrivedAt];
      }
    },
    request: () => Promise.reject(new Error('offline')),
  };
  const tickets: TicketRequests = {
    list: () => Promise.reject(new Error('not used')),
    get: () => Promise.reject(new Error('not used')),
    update: () => Promise.reject(new Error('not used')),
    create: () => Promise.reject(new Error('not used')),
    move: () => Promise.reject(new Error('not used')),
    planMore: () => Promise.reject(new Error('not used')),
    trackerProjects: () => Promise.reject(new Error('not used')),
    trackerViews: () => Promise.reject(new Error('not used')),
    talk: async (message) => {
      record(`talk ${String(message.folder)} ${String(message.ticketId)}`);

      return { podId: 'talk-e5f6' };
    },
    startBuilding: async (message) => {
      record(`build ${String(message.folder)} ${String(message.projectId)}`);

      return 'build-c3d4';
    },
  };
  const runtime = createRuntime({
    runnerId: () => 'rnr_1',
    computer: "Leslie's MacBook",
    client: () => client,
    makeHost: host,
    startDeps,
    log: () => undefined,
    env,
    now: overrides.now,
    tickets,
    building: overrides.building ?? (() => null),
    whoAmI:
      overrides.whoAmI ?? (async () => ({ identities: [], problems: [] })),
  });
  const podNew = (folder: string, text: string) =>
    runtime.handle({
      type: 'pod-new',
      id: randomId('r'),
      folder,
      projectId: 'prj_sweetums',
      intake: { text, freeform: false, single: false },
    });

  return {
    runtime,
    calls,
    env,
    pawnee,
    sweetums,
    podNew,
    cleanup: () =>
      [home, pawnee, sweetums].forEach((dir) =>
        fs.rmSync(dir, { recursive: true, force: true })
      ),
  };
};

describe('a pod for another project switches the runner over', () => {
  it('stops, starts with resume-all, then starts the waiting pod there', async () => {
    const { runtime, calls, env, pawnee, sweetums, cleanup } = setup();

    const podId = await runtime.handle({
      type: 'pod-new',
      id: 'r1',
      folder: sweetums,
      projectId: 'prj_sweetums',
      intake: { text: 'Nougat tracker', freeform: false, single: false },
    });

    expect(podId).toBe('nougat-tracker');
    const at = (line: string): number => calls.log.indexOf(line);

    // stop on the old folder (it had nothing running), then start on the new
    // one, ending with resume-all, then the waiting pod.
    expect(at('✓ Nothing was running')).toBeGreaterThan(-1);
    expect(at(`resume-all ${sweetums}`)).toBeGreaterThan(
      at('✓ Nothing was running')
    );
    expect(at(`new ${sweetums} Nougat tracker prj_sweetums`)).toBeGreaterThan(
      at(`resume-all ${sweetums}`)
    );
    expect(calls.log).not.toContain(`resume-all ${pawnee}`);
    expect(calls.log[0]).toBe(`runner-state ${pawnee} ${sweetums}`);
    expect(calls.log.at(-1)).toBe(`runner-state ${sweetums} null`);
    expect(readRunnerState(env).current).toBe(sweetums);

    cleanup();
  });

  it('says when it arrived on each project, so an empty one still waits 5 idle minutes', async () => {
    const clock = { now: Date.UTC(2026, 9, 21, 9) };
    const { runtime, calls, sweetums, podNew, cleanup } = setup({
      now: () => clock.now,
    });
    const startedAt = clock.now;

    await runtime.linkCurrent();
    clock.now += 60_000;
    await podNew(sweetums, 'Nougat tracker');

    // On Pawnee since it started; on Sweetums from the switch's end.
    expect(calls.arrivals[0]).toBe(startedAt);
    expect(calls.arrivals.at(-1)).toBe(startedAt + 60_000);

    cleanup();
  });

  it("drops the old project's pod host, so its watchdog can't resume what stop ended", async () => {
    const { runtime, calls, pawnee, sweetums, podNew, cleanup } = setup();
    runtime.host(pawnee);

    await podNew(sweetums, 'Nougat tracker');

    expect(calls.disposed).toEqual([pawnee]);
    expect([...runtime.hosts.keys()]).toEqual([sweetums]);
    expect(runtime.isCurrent(pawnee)).toBe(false);

    cleanup();
  });

  it('drops the pod host of a project lambda stop left', async () => {
    const { runtime, calls, env, pawnee, cleanup } = setup();
    runtime.host(pawnee);

    writeRunnerState({ current: null }, env);
    await runtime.pollCurrent();

    expect(calls.disposed).toEqual([pawnee]);
    expect([...runtime.hosts.keys()]).toEqual([]);

    cleanup();
  });

  it('mid-switch, refuses a pod for the project being left and holds one for the new project until it is up', async () => {
    const gate: { open?: () => void } = {};
    const opened = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const { calls, pawnee, sweetums, podNew, cleanup } = setup({
      holdStart: () => opened,
    });

    const first = podNew(sweetums, 'Nougat tracker');
    await new Promise((resolve) => setImmediate(resolve));

    await expect(podNew(pawnee, 'Dog park')).rejects.toThrow(
      "Leslie's MacBook is switching codebases. Try again in a minute."
    );
    const second = podNew(sweetums, 'Candy wrapper');
    gate.open?.();

    await expect(first).resolves.toBe('nougat-tracker');
    await expect(second).resolves.toBe('nougat-tracker');
    expect(calls.log.filter((line) => line.startsWith('resume-all'))).toEqual([
      `resume-all ${sweetums}`,
    ]);
    expect(calls.log.filter((line) => line.startsWith('new'))).toEqual([
      `new ${sweetums} Nougat tracker prj_sweetums`,
      `new ${sweetums} Candy wrapper prj_sweetums`,
    ]);

    cleanup();
  });
});

describe('building on another project switches the runner over too', () => {
  it("stops, starts with resume-all, then builds there, holding that project's pods", async () => {
    const { runtime, calls, env, pawnee, sweetums, cleanup } = setup();
    runtime.host(pawnee);

    const podId = await runtime.handle({
      type: 'building-start',
      id: 'r1',
      folder: sweetums,
      projectId: 'prj_sweetums',
    });

    expect(podId).toBe('build-c3d4');
    const at = (line: string): number => calls.log.indexOf(line);

    expect(at(`resume-all ${sweetums}`)).toBeGreaterThan(-1);
    expect(at(`build ${sweetums} prj_sweetums`)).toBeGreaterThan(
      at(`resume-all ${sweetums}`)
    );
    // Held, so tickBuilding picks it up, watches it and pushes its state.
    expect([...runtime.hosts.keys()]).toEqual([sweetums]);
    expect(calls.disposed).toEqual([pawnee]);
    expect(readRunnerState(env).current).toBe(sweetums);
    expect(runtime.isCurrent(sweetums)).toBe(true);

    cleanup();
  });

  it('builds on the current project without a switch, and holds it', async () => {
    const { runtime, calls, pawnee, cleanup } = setup();

    await runtime.handle({
      type: 'building-start',
      id: 'r1',
      folder: pawnee,
      projectId: 'prj_pawnee',
    });

    expect(calls.log).toEqual([`build ${pawnee} prj_pawnee`]);
    expect([...runtime.hosts.keys()]).toEqual([pawnee]);

    cleanup();
  });
});

describe('a computer building one project refuses to switch to another', () => {
  const buildingPawnee = (pawnee: () => string) => () => ({
    project: 'Pawnee Parks site',
    podsRoot: path.join(pawnee(), '.lambda', 'pods'),
    podId: 'build-a1b2',
  });
  const refusal =
    "Leslie's MacBook is already building Pawnee Parks site. Add another computer to build two tickets at once.";

  /** Pawnee's building pod, on a ticket (`running`) or idle with nothing Ready. */
  const writeBuildingState = (pawnee: string, running: boolean): void => {
    const dir = path.join(pawnee, '.lambda', 'pods', 'build-a1b2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'building.json'),
      JSON.stringify({
        runs: running
          ? [
              {
                id: 'PAW-7',
                title: 'Fix the Lot 48 fence',
                step: 'dev',
                attempt: 1,
                startedAt: '2026-10-23T10:00:00.000Z',
              },
            ]
          : [],
        upNext: [],
        idleReason: 'Nothing ready to build',
      })
    );
  };

  it('refuses a build elsewhere before stopping anything, even with nothing Ready', async () => {
    const held: { pawnee: string } = { pawnee: '' };
    const { runtime, calls, env, pawnee, sweetums, cleanup } = setup({
      building: buildingPawnee(() => held.pawnee),
    });
    held.pawnee = pawnee;
    writeBuildingState(pawnee, false);

    await expect(
      runtime.handle({
        type: 'building-start',
        id: 'r1',
        folder: sweetums,
        projectId: 'prj_sweetums',
      })
    ).rejects.toThrow(refusal);

    // No stop ran, no switch was announced, the computer stayed put.
    expect(calls.log).toEqual([]);
    expect(readRunnerState(env).current).toBe(pawnee);

    cleanup();
  });

  it('refuses a pod elsewhere while the building pod is on a ticket', async () => {
    const held: { pawnee: string } = { pawnee: '' };
    const { runtime, calls, env, pawnee, sweetums, podNew, cleanup } = setup({
      building: buildingPawnee(() => held.pawnee),
    });
    held.pawnee = pawnee;
    writeBuildingState(pawnee, true);

    await expect(podNew(sweetums, 'Nougat tracker')).rejects.toThrow(refusal);

    expect(calls.log).toEqual([]);
    expect(readRunnerState(env).current).toBe(pawnee);
    expect(runtime.isCurrent(pawnee)).toBe(true);

    cleanup();
  });

  it('lets a pod elsewhere switch over while the building pod has nothing Ready', async () => {
    const held: { pawnee: string } = { pawnee: '' };
    const { calls, env, pawnee, sweetums, podNew, cleanup } = setup({
      building: buildingPawnee(() => held.pawnee),
    });
    held.pawnee = pawnee;
    writeBuildingState(pawnee, false);

    await expect(podNew(sweetums, 'Nougat tracker')).resolves.toBe(
      'nougat-tracker'
    );
    // resume-all on the way back brings the building pod back.
    expect(calls.log).toContain(`new ${sweetums} Nougat tracker prj_sweetums`);
    expect(readRunnerState(env).current).toBe(sweetums);

    cleanup();
  });

  it('still starts a pod on the project it is building', async () => {
    const held: { pawnee: string } = { pawnee: '' };
    const { calls, pawnee, podNew, cleanup } = setup({
      building: buildingPawnee(() => held.pawnee),
    });
    held.pawnee = pawnee;

    await expect(podNew(pawnee, 'Dog park')).resolves.toBe('nougat-tracker');
    expect(calls.log).toEqual([`new ${pawnee} Dog park prj_sweetums`]);

    cleanup();
  });
});

describe('talking about a ticket', () => {
  it("holds the ticket's project, so its one-shot Product manager is put to sleep", async () => {
    const { runtime, calls, sweetums, cleanup } = setup();

    await runtime.handle({
      type: 'ticket-talk',
      id: 'r1',
      folder: sweetums,
      ticketId: 'SWE-12',
      text: 'Why is the nougat late?',
    });

    // Held without a switch: tickBuilding watches its pods from here.
    expect([...runtime.hosts.keys()]).toEqual([sweetums]);
    expect(calls.log).toEqual([`talk ${sweetums} SWE-12`]);
    expect(runtime.isCurrent(sweetums)).toBe(false);

    cleanup();
  });
});

describe('who this computer is in its trackers', () => {
  it('reports it on every connect, and keeps the map Lambda hands back', async () => {
    const { runtime, calls, env, cleanup } = setup({
      whoAmI: async () => ({
        identities: [
          {
            tracker: 'linear',
            who: 'leslie-mac@pawnee.gov',
            name: 'Leslie Mac',
          },
        ],
        problems: [],
      }),
    });

    await runtime.onConnected();

    expect(calls.log).toContain(
      'tracker-identity [{"tracker":"linear","who":"leslie-mac@pawnee.gov","name":"Leslie Mac"}]'
    );

    const known = {
      linear: { "Leslie's MacBook": 'leslie-mac@pawnee.gov' },
      jira: {},
      computers: { rnr_1: "Leslie's MacBook" },
    };
    runtime.setOwner(
      { name: 'Leslie Knope', email: 'leslie@pawnee.gov', aliases: [] },
      known
    );

    expect(readKnownAssignees(env)).toEqual(known);
    cleanup();
  });
});
