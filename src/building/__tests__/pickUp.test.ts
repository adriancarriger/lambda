import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  createBuildingDriver,
  notYoursReason,
  pendingReleases,
} from '../driver';
import type { OwnerIdentity } from '../owner';
import { pickUp } from '../pickUp';
import {
  LESLIE,
  buildingPodStore,
  fakeMothership,
  fakeSource,
  ticket,
} from './fakes';

const RUNNER = 'r-leslie-mac';

const RON = { name: 'Ron Swanson', email: 'ron@pawnee.gov' };

const pick = (
  tickets: ReturnType<typeof ticket>[],
  owner: OwnerIdentity | null = LESLIE,
  mothership = fakeMothership(owner ?? LESLIE)
) => {
  const source = fakeSource(tickets);

  return {
    source,
    mothership,
    /** Pick up, then ship what was picked, as the pod would before the next. */
    runAndShip: async () => {
      const result = await pickUp({
        source,
        owner,
        runnerId: RUNNER,
        skipped: [],
        ...mothership.forRunner(RUNNER),
      });

      if (result.kind === 'picked') {
        mothership.forRunner(RUNNER).shipped(result.ticket.id);
      }

      return result;
    },
    run: () =>
      pickUp({
        source,
        owner,
        runnerId: RUNNER,
        skipped: [],
        ...mothership.forRunner(RUNNER),
      }),
  };
};

const pickedId = async (
  result: ReturnType<ReturnType<typeof pick>['run']>
): Promise<string | null> => {
  const settled = await result;

  return settled.kind === 'picked' ? settled.ticket.id : null;
};

describe('a computer takes only its owner’s tickets', () => {
  it('takes Leslie’s, never Ron’s', async () => {
    const { run } = pick([
      ticket('1', { reporter: RON }),
      ticket('2', {
        reporter: { name: 'Leslie Knope', email: LESLIE.email ?? '' },
      }),
    ]);

    expect(await pickedId(run())).toBe('2');
  });

  it('never takes a teammate’s ticket, even with nothing else', async () => {
    const { run } = pick([ticket('1', { reporter: RON })]);

    expect((await run()).kind).toBe('nothing');
  });

  it('says which Ready tickets it passed over as someone else’s', async () => {
    const { run } = pick([
      ticket('1', { reporter: RON }),
      ticket('2', { reporter: RON, status: 'planning' }),
      ticket('3', { reporter: null }),
    ]);
    const result = await run();

    // 3 has no reporter, so it's the owner's: taken, never "not yours".
    expect(result.kind).toBe('picked');

    const idle = await pick([
      ticket('1', { reporter: RON }),
      ticket('2', { reporter: RON, status: 'planning' }),
    ]).run();

    expect(
      idle.kind === 'nothing' ? idle.notYours.map((one) => one.id) : idle.kind
    ).toEqual(['1']);
  });

  it('names them, who reported them and the fix in the idle line', () => {
    expect(notYoursReason([])).toBeNull();
    expect(notYoursReason([ticket('1', { reporter: RON })])).toBe(
      "Skipping 1: Ready, but reported by ron@pawnee.gov, and Lambda builds only tickets you report. If that's you, run lambda account alias add ron@pawnee.gov"
    );
    expect(
      notYoursReason(
        ['1', '2', '3', '4'].map((id) =>
          ticket(id, { reporter: { name: 'Pawnee build bot' } })
        )
      )
    ).toBe(
      'Skipping 1, 2, 3 and 1 more: Ready, but reported by Pawnee build bot, and Lambda builds only tickets you report. If that\'s you, run lambda account alias add "Pawnee build bot"'
    );
  });

  it('matches by email first, whatever the name', async () => {
    const { run } = pick([
      ticket('1', {
        reporter: { name: 'Pawnee build bot', email: 'Leslie@Pawnee.gov' },
      }),
    ]);

    expect(await pickedId(run())).toBe('1');
  });

  it('falls back to the name for a reporter with no email', async () => {
    const { run } = pick([ticket('1', { reporter: { name: 'Leslie Knope' } })]);

    expect(await pickedId(run())).toBe('1');
  });

  it('takes a ticket with no reporter', async () => {
    const { run } = pick([ticket('1', { reporter: null })]);

    expect(await pickedId(run())).toBe('1');
  });

  it('sets the ticket building once claimed', async () => {
    const { run, source, mothership } = pick([ticket('1')]);

    await run();

    expect(source.statusOf('1')).toBe('building');
    expect(mothership.rows.get('1')?.runnerId).toBe(RUNNER);
  });
});

describe('reporter matching with aliases', () => {
  const owner: OwnerIdentity = {
    ...LESLIE,
    aliases: [{ kind: 'email', value: 'lknope@pawnee.gov' }],
  };

  const takenFrom = async (
    tickets: ReturnType<typeof ticket>[],
    who: OwnerIdentity = owner
  ): Promise<string[]> => {
    const { runAndShip } = pick(tickets, who);
    // Bounded: at most one pick-up per ticket, plus the one that finds none.
    const loop = async (taken: string[]): Promise<string[]> => {
      if (taken.length > tickets.length) {
        throw new Error(
          `Picked more tickets than there are: ${taken.join(', ')}`
        );
      }

      const result = await runAndShip();

      if (result.kind === 'picked') {
        return loop([...taken, result.ticket.id]);
      }

      return taken;
    };

    return loop([]);
  };

  it('takes the alias and the owner’s own email, never Ron’s', async () => {
    expect(
      await takenFrom([
        ticket('1', {
          reporter: { name: 'Pawnee build bot', email: 'LKnope@Pawnee.gov' },
        }),
        ticket('2', {
          reporter: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
        }),
        ticket('3', { reporter: RON }),
      ])
    ).toEqual(['1', '2']);
  });

  it('takes a name alias for a reporter with no email', async () => {
    expect(
      await takenFrom([ticket('1', { reporter: { name: 'knope' } })], {
        ...owner,
        aliases: [...owner.aliases, { kind: 'name', value: 'Knope' }],
      })
    ).toEqual(['1']);
  });

  it('still takes owner.name when the email matches nothing', async () => {
    expect(
      await takenFrom([
        ticket('1', {
          reporter: { name: 'Leslie Knope', email: 'leslie@home.example' },
        }),
      ])
    ).toEqual(['1']);
  });
});

describe('the owner comes from the mothership, never the runner’s own config', () => {
  it('matches against the owner message, so Ron’s config or none changes nothing', async () => {
    // The runner never reads its own ~/.lambda/config.json owner: only the
    // copy the mothership sent (`owner`), handed in here.
    const fromMothership: OwnerIdentity = {
      name: 'Leslie Knope',
      email: 'leslie@pawnee.gov',
      aliases: [{ kind: 'email', value: 'lknope@pawnee.gov' }],
    };
    const tickets = [
      ticket('1', { reporter: RON }),
      ticket('2', { reporter: { name: 'Leslie', email: 'leslie@pawnee.gov' } }),
      ticket('3', { reporter: { name: 'Bot', email: 'lknope@pawnee.gov' } }),
    ];

    const { runAndShip } = pick(tickets, fromMothership);
    expect(await pickedId(runAndShip())).toBe('2');
    expect(await pickedId(runAndShip())).toBe('3');
    expect((await runAndShip()).kind).toBe('nothing');
  });

  it('waits when the mothership has sent no owner yet', async () => {
    const { run, mothership } = pick([ticket('1')], null);

    expect((await run()).kind).toBe('unreachable');
    expect(mothership.rows.size).toBe(0);
  });

  it('takes a ticket an alias added later names, on the next pick-up', async () => {
    const owner: OwnerIdentity = { ...LESLIE, aliases: [] };
    const source = fakeSource([
      ticket('1', { reporter: { name: 'Bot', email: 'knope@pawnee.gov' } }),
    ]);
    const mothership = fakeMothership({
      ...LESLIE,
      aliases: [{ kind: 'email', value: 'knope@pawnee.gov' }],
    });
    const once = (who: OwnerIdentity) =>
      pickUp({
        source,
        owner: who,
        runnerId: RUNNER,
        skipped: [],
        ...mothership.forRunner(RUNNER),
      });

    expect((await once(owner)).kind).toBe('nothing');
    expect(
      (
        await once({
          ...owner,
          aliases: [{ kind: 'email', value: 'knope@pawnee.gov' }],
        })
      ).kind
    ).toBe('picked');
  });

  it('moves on when the mothership refuses a reporter as not-owner', async () => {
    // The runner's copy says Ron is the owner's; the mothership knows better.
    const confused: OwnerIdentity = {
      ...LESLIE,
      aliases: [{ kind: 'email', value: 'ron@pawnee.gov' }],
    };
    const { run, mothership } = pick(
      [ticket('1', { reporter: RON }), ticket('2')],
      confused,
      fakeMothership(LESLIE)
    );

    expect(await pickedId(run())).toBe('2');
    expect(mothership.rows.has('1')).toBe(false);
  });
});

describe('with the mothership unreachable', () => {
  it('starts nothing, and asks again after 60 seconds', async () => {
    const { store, root, podId } = buildingPodStore('build-c3d4', RUNNER);
    const source = fakeSource([ticket('1')]);
    const mothership = fakeMothership();
    mothership.state.reachable = false;
    const clock = { now: Date.parse('2026-10-23T10:00:00.000Z') };
    const sent: { texts: string[] } = { texts: [] };
    const driver = createBuildingDriver({
      store,
      podId,
      projectRoot: root,
      runnerId: RUNNER,
      source: () => source,
      owner: () => LESLIE,
      mothership: mothership.forRunner(RUNNER),
      interrupt: async () => undefined,
      send: async (_target, text) => {
        sent.texts = [...sent.texts, text];
      },
      block: async () => undefined,
      panes: () => '',
      now: () => clock.now,
      log: () => undefined,
    });

    await driver.tick();
    const { asked } = mothership.state;
    expect(store.readBuilding(podId).runs).toEqual([]);
    expect(source.statusOf('1')).toBe('ready');
    expect(sent.texts).toEqual([]);

    clock.now += 30_000;
    await driver.tick();
    expect(mothership.state.asked).toBe(asked);

    mothership.state.reachable = true;
    clock.now += 30_000;
    await driver.tick();
    expect(store.readBuilding(podId).runs.map((run) => run.id)).toEqual(['1']);
    expect(source.statusOf('1')).toBe('building');
  });
});

describe('a status update that fails after the claim', () => {
  it('lets the claim go and says why, and the next pick-up takes the ticket', async () => {
    const { run, source, mothership } = pick([ticket('1')]);
    source.failNextUpdate('1');

    const failed = await run();

    expect(failed).toEqual({
      kind: 'failed',
      ticketId: '1',
      reason: 'Linear answered 500: Internal server error',
    });
    expect(mothership.rows.has('1')).toBe(false);
    expect(await pickedId(run())).toBe('1');
    expect(source.statusOf('1')).toBe('building');
  });

  it('takes back its own claim when the release never reached the mothership', async () => {
    const mothership = fakeMothership();
    mothership.rows.set('1', {
      ticketId: '1',
      runnerId: RUNNER,
      shippedAt: null,
    });
    const { run, source } = pick([ticket('1')], LESLIE, mothership);

    expect(await pickedId(run())).toBe('1');
    expect(source.statusOf('1')).toBe('building');
  });

  it('keeps the pod idle with the reason, and tries again after 60 seconds', async () => {
    const { store, root, podId } = buildingPodStore('build-e5f6', RUNNER);
    const source = fakeSource([ticket('1')]);
    source.failNextUpdate('1');
    const mothership = fakeMothership();
    const clock = { now: Date.parse('2026-10-23T10:00:00.000Z') };
    const driver = createBuildingDriver({
      store,
      podId,
      projectRoot: root,
      runnerId: RUNNER,
      source: () => source,
      owner: () => LESLIE,
      mothership: mothership.forRunner(RUNNER),
      interrupt: async () => undefined,
      send: async () => undefined,
      block: async () => undefined,
      panes: () => '',
      now: () => clock.now,
      log: () => undefined,
    });

    await driver.tick();
    expect(store.readBuilding(podId).runs).toEqual([]);
    expect(store.readBuilding(podId).idleReason).toBe(
      "Couldn't set 1 to building: Linear answered 500: Internal server error"
    );

    clock.now += 60_000;
    await driver.tick();
    expect(store.readBuilding(podId).runs.map((one) => one.id)).toEqual(['1']);
  });
});

describe('a ticket source that fails to answer', () => {
  it('keeps the pod idle with the reason, and asks again only after 60 seconds', async () => {
    const { store, root, podId } = buildingPodStore('build-g7h8', RUNNER);
    const working = fakeSource([ticket('1')]);
    const asked = { times: 0, failing: true };
    const source = {
      ...working,
      queue: async () => {
        asked.times += 1;

        if (asked.failing) {
          throw new Error('Linear answered 429: Rate limited');
        }

        return working.queue();
      },
    };
    const clock = { now: Date.parse('2026-10-23T10:00:00.000Z') };
    const driver = createBuildingDriver({
      store,
      podId,
      projectRoot: root,
      runnerId: RUNNER,
      source: () => source,
      owner: () => LESLIE,
      mothership: fakeMothership().forRunner(RUNNER),
      interrupt: async () => undefined,
      send: async () => undefined,
      block: async () => undefined,
      panes: () => '',
      now: () => clock.now,
      log: () => undefined,
    });

    await expect(driver.tick()).rejects.toThrow('Rate limited');
    expect(store.readBuilding(podId).idleReason).toBe(
      "Couldn't read tickets: Linear answered 429: Rate limited"
    );

    clock.now += 30_000;
    await driver.tick();
    expect(asked.times).toBe(1);

    asked.failing = false;
    clock.now += 30_000;
    await driver.tick();
    expect(asked.times).toBe(2);
    expect(store.readBuilding(podId).runs.map((one) => one.id)).toEqual(['1']);
  });

  it("says Lambda's own refusal is Lambda's, not the tickets'", async () => {
    const { store, root, podId } = buildingPodStore('build-g7h8', RUNNER);
    const working = fakeMothership().forRunner(RUNNER);
    const driver = createBuildingDriver({
      store,
      podId,
      projectRoot: root,
      runnerId: RUNNER,
      source: () => fakeSource([ticket('1')]),
      owner: () => LESLIE,
      mothership: {
        ...working,
        claim: async () => {
          throw new Error(
            'Lambda answered the claim with something unexpected.'
          );
        },
      },
      interrupt: async () => undefined,
      send: async () => undefined,
      block: async () => undefined,
      panes: () => '',
      now: () => Date.parse('2026-10-23T10:00:00.000Z'),
      log: () => undefined,
    });

    await expect(driver.tick()).rejects.toThrow('something unexpected');
    expect(store.readBuilding(podId).idleReason).toBe(
      "Couldn't claim a ticket: Lambda answered the claim with something unexpected."
    );
  });
});

const driverOn = (
  setup: ReturnType<typeof buildingPodStore>,
  source: ReturnType<typeof fakeSource>,
  extra: { log?: (line: string) => void } = {}
) => {
  const mothership = fakeMothership();
  const clock = { now: Date.parse('2026-10-23T10:00:00.000Z') };
  const driver = createBuildingDriver({
    store: setup.store,
    podId: setup.podId,
    projectRoot: setup.root,
    runnerId: RUNNER,
    source: () => source,
    owner: () => LESLIE,
    mothership: mothership.forRunner(RUNNER),
    interrupt: async () => undefined,
    send: async () => undefined,
    block: async () => undefined,
    panes: () => '',
    now: () => clock.now,
    log: extra.log ?? (() => undefined),
  });

  return { driver, clock, mothership };
};

describe('a checkout with uncommitted work', () => {
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  it('starts no ticket, claims nothing, and says why', async () => {
    const setup = buildingPodStore('build-c3d4', RUNNER);
    git(setup.root, ['init', '-q', '-b', 'main']);
    git(setup.root, ['config', 'user.email', 'leslie@pawnee.gov']);
    git(setup.root, ['config', 'user.name', 'Leslie Knope']);
    fs.writeFileSync(path.join(setup.root, '.gitignore'), '.lambda/\n');
    git(setup.root, ['add', '-A']);
    git(setup.root, ['commit', '-q', '-m', 'start']);
    fs.writeFileSync(path.join(setup.root, 'lot-48.md'), 'Half done.\n');
    const source = fakeSource([ticket('1')]);
    const { driver, mothership } = driverOn(setup, source);

    await driver.tick();

    expect(setup.store.readBuilding(setup.podId).runs).toEqual([]);
    expect(mothership.rows.size).toBe(0);
    expect(source.statusOf('1')).toBe('ready');
    expect(setup.store.readBuilding(setup.podId).idleReason).toBe(
      `${setup.root} has uncommitted changes (1 file): commit or stash them, and the next ticket starts.`
    );
    fs.rmSync(setup.root, { recursive: true, force: true });
  });
});

describe('a ticket that never can be set building', () => {
  it('is skipped for this pod after three tries, and the pod takes the next', async () => {
    const setup = buildingPodStore('build-i9j0', RUNNER);
    const working = fakeSource([ticket('1'), ticket('2')]);
    const source = {
      ...working,
      update: async (
        id: string,
        input: Parameters<typeof working.update>[1]
      ) => {
        if (id === '1' && input.status === 'building') {
          throw new Error('Linear answered 500: Internal server error');
        }

        return working.update(id, input);
      },
    };
    const logged: string[] = [];
    const { driver, clock } = driverOn(setup, source, {
      log: (line) => logged.splice(logged.length, 0, line),
    });

    await [1, 2, 3, 4].reduce(async (previous) => {
      await previous;
      await driver.tick();
      clock.now += 60_000;
    }, Promise.resolve());

    expect(setup.store.requirePod(setup.podId).skipped).toEqual(['1']);
    expect(logged).toContain(
      "Couldn't set 1 to building 3 times (Linear answered 500: Internal server error): skipped it for this pod."
    );
    expect(
      setup.store.readBuilding(setup.podId).runs.map((one) => one.id)
    ).toEqual(['2']);
    fs.rmSync(setup.root, { recursive: true, force: true });
  });
});

describe('a pod ended while its pick-up was claiming', () => {
  it('gets no run, and the claimed ticket goes back to Ready, released', async () => {
    const setup = buildingPodStore('build-k1l2', RUNNER);
    const source = fakeSource([ticket('1')]);
    const mothership = fakeMothership();
    const runner = mothership.forRunner(RUNNER);
    const sent: { texts: string[] } = { texts: [] };
    const driver = createBuildingDriver({
      store: setup.store,
      podId: setup.podId,
      projectRoot: setup.root,
      runnerId: RUNNER,
      source: () => source,
      owner: () => LESLIE,
      mothership: {
        ...runner,
        // The owner runs `lambda pod done` while the claim is on its way.
        claim: async (ticketId, reporter) => {
          const outcome = await runner.claim(ticketId, reporter);
          setup.store.updatePod(setup.podId, (pod) => ({
            ...pod,
            status: 'done',
          }));

          return outcome;
        },
      },
      interrupt: async () => undefined,
      send: async (_target, text) => {
        sent.texts = [...sent.texts, text];
      },
      block: async () => undefined,
      panes: () => '',
      now: () => Date.parse('2026-10-23T10:00:00.000Z'),
      log: () => undefined,
    });

    try {
      await driver.tick();

      expect(setup.store.readBuilding(setup.podId).runs).toEqual([]);
      expect(mothership.rows.has('1')).toBe(false);
      expect(source.statusOf('1')).toBe('ready');
      expect(sent.texts).toEqual([]);
    } finally {
      fs.rmSync(setup.root, { recursive: true, force: true });
    }
  });

  it('says why when the tracker refuses to put the ticket back, and leaves it for the runner', async () => {
    const setup = buildingPodStore('build-m3n4', RUNNER);
    const source = fakeSource([ticket('1')]);
    const mothership = fakeMothership();
    const runner = mothership.forRunner(RUNNER);
    const logged: string[] = [];
    const driver = createBuildingDriver({
      store: setup.store,
      podId: setup.podId,
      projectRoot: setup.root,
      runnerId: RUNNER,
      source: () => ({
        ...source,
        update: async (id, input) => {
          if (input.status === 'ready') {
            throw new Error('Linear answered 500: Internal server error');
          }

          return source.update(id, input);
        },
      }),
      owner: () => LESLIE,
      mothership: {
        ...runner,
        claim: async (ticketId, reporter) => {
          const outcome = await runner.claim(ticketId, reporter);
          setup.store.updatePod(setup.podId, (pod) => ({
            ...pod,
            status: 'done',
          }));

          return outcome;
        },
      },
      interrupt: async () => undefined,
      send: async () => undefined,
      block: async () => undefined,
      panes: () => '',
      now: () => Date.parse('2026-10-23T10:00:00.000Z'),
      log: (line) => {
        logged.splice(logged.length, 0, line);
      },
    });

    try {
      await driver.tick();

      expect(logged).toContain(
        "Couldn't set 1 back to Ready (Linear answered 500: Internal server error): left for the runner to release."
      );
      expect(
        pendingReleases(setup.store.root).map((left) => left.ticketId)
      ).toEqual(['1']);
    } finally {
      fs.rmSync(setup.root, { recursive: true, force: true });
    }
  });
});

describe('a pick-up message that fails to send', () => {
  it('is sent again on the next tick, once', async () => {
    const { store, root, podId } = buildingPodStore('build-e5f6', RUNNER);
    const source = fakeSource([ticket('1')]);
    const mothership = fakeMothership();
    const sent: { texts: string[]; fail: boolean } = { texts: [], fail: true };
    const driver = createBuildingDriver({
      store,
      podId,
      projectRoot: root,
      runnerId: RUNNER,
      source: () => source,
      owner: () => LESLIE,
      mothership: mothership.forRunner(RUNNER),
      interrupt: async () => undefined,
      send: async (_target, text) => {
        if (sent.fail) {
          throw new Error('pane not ready');
        }

        sent.texts = [...sent.texts, text];
      },
      block: async () => undefined,
      panes: () => '',
      now: () => Date.parse('2026-10-23T10:00:00.000Z'),
      log: () => undefined,
    });

    await expect(driver.tick()).rejects.toThrow('pane not ready');
    expect(store.readBuilding(podId).runs.map((run) => run.announced)).toEqual([
      false,
    ]);

    sent.fail = false;
    await driver.tick();
    await driver.tick();

    expect(sent.texts).toHaveLength(1);
    expect(sent.texts[0]).toMatch(/^Picked up 1 .*\(ticket 1 of 1\)/);
    expect(store.readBuilding(podId).runs.map((run) => run.announced)).toEqual([
      true,
    ]);
  });
});

describe("a ticket's screenshot scenarios at pick-up", () => {
  const driverPulling = (
    setup: ReturnType<typeof buildingPodStore>,
    source: ReturnType<typeof fakeSource>,
    pullScenarios: (ticketId: string) => Promise<void>
  ) =>
    createBuildingDriver({
      store: setup.store,
      podId: setup.podId,
      projectRoot: setup.root,
      runnerId: RUNNER,
      source: () => source,
      owner: () => LESLIE,
      mothership: fakeMothership().forRunner(RUNNER),
      interrupt: async () => undefined,
      send: async () => undefined,
      block: async () => undefined,
      panes: () => '',
      now: () => Date.parse('2026-10-23T10:00:00.000Z'),
      log: () => undefined,
      pullScenarios,
    });

  const bubbles = (setup: ReturnType<typeof buildingPodStore>) =>
    setup.store
      .readThread(setup.podId)
      .filter((entry) => entry.from === 'engineering-manager')
      .map((entry) => entry.text);

  it('pulls them once the ticket is claimed', async () => {
    const setup = buildingPodStore('build-s1c2', RUNNER);
    const pulled: string[] = [];
    const driver = driverPulling(
      setup,
      fakeSource([ticket('PAWNEE-5')]),
      async (id) => {
        pulled.splice(pulled.length, 0, id);
      }
    );

    try {
      await driver.tick();
      await driver.tick();

      expect(pulled).toEqual(['PAWNEE-5']);
      expect(bubbles(setup)).toEqual([]);
    } finally {
      fs.rmSync(setup.root, { recursive: true, force: true });
    }
  });

  it('posts a bubble when the pull fails, and the ticket still builds', async () => {
    const setup = buildingPodStore('build-s3c4', RUNNER);
    const source = fakeSource([ticket('PAWNEE-5')]);
    const driver = driverPulling(setup, source, async () => {
      throw new Error('Linear answered 503: Service unavailable');
    });

    try {
      await driver.tick();

      expect(source.statusOf('PAWNEE-5')).toBe('building');
      expect(
        setup.store.readBuilding(setup.podId).runs.map((run) => run.id)
      ).toEqual(['PAWNEE-5']);
      expect(bubbles(setup)).toEqual([
        "Couldn't fetch PAWNEE-5's screenshot scenarios (Linear answered 503: Service unavailable).",
      ]);
    } finally {
      fs.rmSync(setup.root, { recursive: true, force: true });
    }
  });

  it('pulls them again when a runner resumes a ticket it was building', async () => {
    const setup = buildingPodStore('build-s5c6', RUNNER);
    const source = fakeSource([ticket('PAWNEE-5')]);
    await driverPulling(setup, source, async () => undefined).tick();
    const pulled: string[] = [];

    try {
      // The runner restarted: a new driver, the same current run.
      const resumed = driverPulling(setup, source, async (id) => {
        pulled.splice(pulled.length, 0, id);
      });
      await resumed.tick();
      await resumed.tick();

      expect(pulled).toEqual(['PAWNEE-5']);
    } finally {
      fs.rmSync(setup.root, { recursive: true, force: true });
    }
  });
});
