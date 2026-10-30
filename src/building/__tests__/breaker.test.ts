import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { buildingReplyItems, withAlsoHeld } from '../../app/shared/building';
import { blockTicket } from '../blocked';
import { pausedByManagerText, twoInARowText } from '../breaker';
import {
  PickUpCommandFailed,
  createBuildingDriver,
  pendingReleases,
  runPickUpCommand,
} from '../driver';
import {
  LESLIE,
  buildingPodStore,
  fakeMothership,
  fakeSource,
  ticket,
} from './fakes';

/**
 * The breaker (Adrian, 2026-10-29): a builder stops taking tickets when its
 * blocks say the trouble isn't the tickets'.
 */

const RUNNER = 'r-leslie-mac';
const T0 = Date.parse('2026-10-29T06:00:00.000Z');

const PARTS = {
  what: 'Trail markers for the Lot 48 pit',
  problem: "The checkout is on main, and the ship can't run there.",
  options: '1) Put the checkout on its branch  2) Pause the builder',
  recommendation: '1, then requeue it.',
};

const setUp = (
  prepare: (ticketId: string) => Promise<string | null> = async () => null
) => {
  const { store, root, podId } = buildingPodStore();
  const source = fakeSource([
    ticket('3', { title: 'Trail markers' }),
    ticket('4', { title: 'Lot 48 photos' }),
    ticket('5', { title: 'Harvest festival map' }),
  ]);
  const mothership = fakeMothership();
  const clock = { now: T0 };
  const sent: { list: { target: string; text: string }[] } = { list: [] };
  const driver = createBuildingDriver({
    store,
    podId,
    projectRoot: root,
    runnerId: RUNNER,
    source: () => source,
    owner: () => LESLIE,
    mothership: mothership.forRunner(RUNNER),
    interrupt: async () => undefined,
    send: async (target, text) => {
      sent.list = [...sent.list, { target, text }];
    },
    block: (ticketId, parts) =>
      blockTicket({ store, podId, ticketId, parts, source }),
    panes: () => '',
    now: () => clock.now,
    log: () => undefined,
    uncommitted: () => [],
    pullScenarios: async () => undefined,
    prepare,
  });

  const tick = async () => {
    clock.now += 61_000;
    await driver.tick();
  };
  const block = (ticketId: string, pause = false) =>
    blockTicket({ store, podId, ticketId, parts: PARTS, source, pause });
  const items = () =>
    buildingReplyItems(
      withAlsoHeld(store.readThread(podId), store.readBuilding(podId)),
      store.readBuilding(podId)
    );
  const paused = () => store.requirePod(podId).status === 'paused';
  const runIds = () => store.readBuilding(podId).runs.map((run) => run.id);

  return {
    store,
    root,
    podId,
    source,
    mothership,
    sent,
    tick,
    block,
    items,
    paused,
    runIds,
  };
};

describe('the breaker', () => {
  it('folds a ticket the same problem held before any work into the block before it, back to Ready, and pauses', async () => {
    const { store, podId, tick, block, items, paused, runIds } = setUp();

    await tick();
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: state.runs.map((run) => ({ ...run, step: 'build' })),
    }));
    await block('3');
    await tick();

    expect(paused()).toBe(false);
    expect(runIds()).toEqual(['3', '4']);

    // Held before it left Pick up: the same problem.
    await block('4');

    expect(paused()).toBe(true);
    expect(runIds()).toEqual(['3']);
    expect(pendingReleases(store.root).map((left) => left.ticketId)).toEqual([
      '4',
    ]);
    // One item, the first block's, now listing the ticket folded into it.
    expect(items()).toHaveLength(1);
    expect(items()[0]?.text).toContain(
      '**Also held by this, not started and back in Ready:** 4 Lot 48 photos.'
    );
    expect(
      store.readBuilding(podId).runs[0]?.blocked?.alsoHeld?.map((one) => one.id)
    ).toEqual(['4']);

    // Paused: nothing more is picked up.
    await tick();
    await tick();

    expect(runIds()).toEqual(['3']);
  });

  it('never sets a folded ticket Blocked in its tracker', async () => {
    const { source, tick, block } = setUp();

    await tick();
    await block('3');
    await tick();
    await block('4');

    expect(source.statusOf('3')).toBe('blocked');
    expect(source.statusOf('4')).toBe('building');
  });

  it('pauses after two blocks in a row, saying so on the second item', async () => {
    const { store, podId, tick, block, items, paused, runIds } = setUp();

    await tick();
    await block('3');
    await tick();
    // The second ticket got past Pick up: its own block, its own item.
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: state.runs.map((run) =>
        run.id === '4' ? { ...run, step: 'build' } : run
      ),
    }));
    await block('4');

    expect(paused()).toBe(true);
    expect(items()).toHaveLength(2);
    expect(items()[1]?.text).toContain(twoInARowText('3', '4'));
    expect(store.readBuilding(podId).pause?.reason).toBe(
      twoInARowText('3', '4')
    );

    await tick();

    expect(runIds()).toEqual(['3', '4']);
  });

  it("pauses on the Engineering manager's --pause, before a second ticket is taken", async () => {
    const { tick, block, items, paused, runIds } = setUp();

    await tick();
    await block('3', true);

    expect(paused()).toBe(true);
    expect(items()[0]?.text).toContain(pausedByManagerText);

    await tick();

    expect(runIds()).toEqual(['3']);
  });

  it('counts no block from before the last Resume', async () => {
    const { store, podId, tick, block, paused, runIds } = setUp();

    await tick();
    await block('3');
    // The owner fixed it and resumed.
    store.updatePod(podId, (pod) => ({ ...pod, status: 'active' }));
    store.updateBuilding(podId, (state) => ({
      ...state,
      resumedAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    await tick();
    await block('4');

    expect(paused()).toBe(false);
    expect(runIds()).toEqual(['3', '4']);
  });
});

describe("the project's pick-up command", () => {
  it('runs for a claimed ticket, and the Engineering manager hears it ran', async () => {
    const asked: { list: string[] } = { list: [] };
    const { store, podId, sent, tick } = setUp(async (ticketId) => {
      asked.list = [...asked.list, ticketId];

      return `./scripts/setup.sh ${ticketId}`;
    });

    await tick();

    expect(asked.list).toEqual(['3']);
    expect(store.readBuilding(podId).runs[0]?.prepared).toBe('./scripts/setup.sh 3');
    expect(sent.list[0]?.text).toContain(
      'Lambda ran `./scripts/setup.sh 3` to set the checkout up for it.'
    );
  });

  it('failing, puts the ticket back, pauses, and tells the owner what it said', async () => {
    const { store, podId, source, mothership, sent, tick, items, paused } =
      setUp(async (ticketId) => {
        throw new PickUpCommandFailed(
          `./scripts/setup.sh ${ticketId}`,
          'setup failed: port 3000 in use'
        );
      });

    await tick();

    expect(store.readBuilding(podId).runs).toEqual([]);
    expect(source.statusOf('3')).toBe('ready');
    expect(mothership.rows.size).toBe(0);
    expect(paused()).toBe(true);
    expect(sent.list).toEqual([]);
    expect(items()).toHaveLength(1);
    expect(items()[0]?.text).toContain('`./scripts/setup.sh 3` failed');
    expect(items()[0]?.text).toContain('setup failed: port 3000 in use');

    // Paused: the next ticket isn't claimed to stop the same way.
    await tick();

    expect(source.statusOf('4')).toBe('ready');
  });
});

describe('the pick-up message', () => {
  it("says where the last ticket's work went when Lambda set it aside", async () => {
    const { store, root, podId, sent, tick, block } = setUp();
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.email=leslie@pawnee.gov',
          '-c',
          'user.name=Leslie',
          ...args,
        ],
        { cwd: root, stdio: 'pipe' }
      );
    fs.writeFileSync(path.join(root, 'map.txt'), 'Lot 48\n');
    // The pods live in the checkout here: ignored, as a project's are.
    fs.writeFileSync(path.join(root, '.gitignore'), '.lambda/\n');
    git('init', '-q');
    git('add', 'map.txt', '.gitignore');
    git('commit', '-q', '-m', 'Start');

    await tick();
    fs.writeFileSync(path.join(root, 'map.txt'), 'Lot 48, the pit\n');
    await block('3');

    expect(store.readBuilding(podId).runs[0]?.blocked?.setAside).toBe(
      'lambda: 3 blocked'
    );

    sent.list = [];
    await tick();

    expect(sent.list[0]?.text).toContain(
      'The checkout is clean: 3\'s work is set aside, not in this tree (`git stash list` shows "lambda: 3 blocked").'
    );
  });
});

describe("lambda.json's commands.pickUp, as the runner runs it", () => {
  const project = (pickUp?: string): string => {
    const { root } = buildingPodStore();
    fs.writeFileSync(
      path.join(root, 'lambda.json'),
      JSON.stringify({
        tickets: { source: 'markdown', prefix: 'PAWNEE' },
        ...(pickUp === undefined ? {} : { commands: { pickUp } }),
      })
    );

    return root;
  };

  it('runs it in the checkout with the ticket id, quoted', async () => {
    const root = project('echo {spec} > picked.txt');

    await expect(runPickUpCommand(root)('PAWNEE-3')).resolves.toBe(
      "echo 'PAWNEE-3' > picked.txt"
    );
    expect(fs.readFileSync(path.join(root, 'picked.txt'), 'utf8')).toBe(
      'PAWNEE-3\n'
    );
  });

  it('is nothing to run without one', async () => {
    await expect(runPickUpCommand(project())('PAWNEE-3')).resolves.toBeNull();
  });

  it('fails with what the command said last', async () => {
    const root = project('echo "setup failed for {spec}: port 3000 in use" >&2; exit 3');

    await expect(runPickUpCommand(root)('PAWNEE-3')).rejects.toMatchObject({
      command: `echo "setup failed for 'PAWNEE-3': port 3000 in use" >&2; exit 3`,
      output: "setup failed for 'PAWNEE-3': port 3000 in use",
    });
  });
});
