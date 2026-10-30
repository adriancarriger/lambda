import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createPodStore } from '../store';

// statSync stays the real one unless a test steps in for one call.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');

  return { ...actual, statSync: jest.fn(actual.statSync) };
});

/**
 * building.json is read, patched and written by several processes at once
 * (the runner's watch, `lambda pod step`, `lambda ship`, a blocked or skipped
 * ticket, a reply, a pause): the read-modify-write holds a lockfile beside
 * it, so one writer never overwrites another's change.
 */

const POD = 'pawnee-a1b2';

const roots: string[] = [];

const tmpRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-store-lock-'));
  roots.splice(roots.length, 0, root);

  return root;
};

const lockOf = (root: string): string =>
  path.join(root, POD, 'building.json.lock');

const holdLock = (root: string, ageMs: number): void => {
  const lock = lockOf(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '4242 someone else\n');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(lock, at, at);
};

const addTitle =
  (title: string) =>
  <T extends { upNext: { id: string; title: string }[] }>(state: T): T => ({
    ...state,
    upNext: [...state.upNext, { id: title, title }],
  });

afterEach(() => {
  roots
    .splice(0, roots.length)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('updateBuilding lock', () => {
  it('updates and leaves no lock behind', () => {
    const root = tmpRoot();
    const store = createPodStore(root);

    store.updateBuilding(POD, addTitle('Lot 48'));
    store.updateBuilding(POD, addTitle('Harvest Festival'));

    expect(store.readBuilding(POD).upNext.map((item) => item.id)).toEqual([
      'Lot 48',
      'Harvest Festival',
    ]);
    expect(fs.existsSync(lockOf(root))).toBe(false);
  });

  it('releases the lock when the patch throws', () => {
    const root = tmpRoot();
    const store = createPodStore(root);

    expect(() =>
      store.updateBuilding(POD, () => {
        throw new Error('Leslie said no');
      })
    ).toThrow('Leslie said no');
    expect(fs.existsSync(lockOf(root))).toBe(false);
  });

  it('waits for a lock another writer holds, then gives up loudly', () => {
    const root = tmpRoot();
    const store = createPodStore(root, {
      buildingLock: { timeoutMs: 120, staleMs: 60_000 },
    });
    holdLock(root, 0);
    const started = Date.now();

    expect(() => store.updateBuilding(POD, addTitle('Lot 48'))).toThrow(
      /building\.json.*lock/
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    // Nothing written while another writer held it, and its lock is kept.
    expect(store.readBuilding(POD).upNext).toEqual([]);
    expect(fs.existsSync(lockOf(root))).toBe(true);
  });

  it('takes over a stale lock (its writer died holding it)', () => {
    const root = tmpRoot();
    const store = createPodStore(root, {
      buildingLock: { timeoutMs: 120, staleMs: 1_000 },
    });
    holdLock(root, 5_000);

    store.updateBuilding(POD, addTitle('Lot 48'));

    expect(store.readBuilding(POD).upNext.map((item) => item.id)).toEqual([
      'Lot 48',
    ]);
    expect(fs.existsSync(lockOf(root))).toBe(false);
  });
});

describe('updateBuilding lock, with two writers at the stale lock', () => {
  it("keeps another writer's lock when that writer took over mid-write", () => {
    const root = tmpRoot();
    const store = createPodStore(root);

    store.updateBuilding(POD, (state) => {
      fs.writeFileSync(lockOf(root), '4243 another writer\n');

      return state;
    });

    expect(fs.readFileSync(lockOf(root), 'utf8')).toBe('4243 another writer\n');
  });

  it('never removes a fresh lock another writer took over first', () => {
    const root = tmpRoot();
    const store = createPodStore(root, {
      buildingLock: { timeoutMs: 100, staleMs: 1_000 },
    });
    holdLock(root, 5_000);
    const stale = jest
      .requireActual<typeof import('fs')>('fs')
      .statSync(lockOf(root));
    const stat = jest.mocked(fs.statSync);
    // Between this writer seeing the lock stale and taking it over, another
    // writer has already taken it over and holds a fresh one.
    stat.mockImplementationOnce(() => {
      fs.writeFileSync(lockOf(root), '4243 another writer\n');

      return stale;
    });

    expect(() => store.updateBuilding(POD, addTitle('Lot 48'))).toThrow(
      /building\.json.*lock/
    );
    expect(fs.readFileSync(lockOf(root), 'utf8')).toBe('4243 another writer\n');
    expect(store.readBuilding(POD).upNext).toEqual([]);
  });
});

describe('updateBuildingAsync', () => {
  it('waits for a held lock without blocking, then writes', async () => {
    const root = tmpRoot();
    const store = createPodStore(root, {
      buildingLock: { timeoutMs: 1_000, staleMs: 60_000 },
    });
    holdLock(root, 0);
    // Only runs if the wait leaves the event loop free.
    setTimeout(() => fs.rmSync(lockOf(root)), 50);

    await store.updateBuildingAsync(POD, addTitle('Lot 48'));

    expect(store.readBuilding(POD).upNext.map((item) => item.id)).toEqual([
      'Lot 48',
    ]);
    expect(fs.existsSync(lockOf(root))).toBe(false);
  });
});
