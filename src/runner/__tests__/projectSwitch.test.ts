import type { PodActivity } from '../../app/shared/snapshot';
import { waitingLabel } from '../../mothership/pods';
import { IDLE_MS, decideSwitch, idleSince, runSwitch } from '../projectSwitch';

const NOW = Date.UTC(2026, 9, 21, 12);
const MINUTE = 60_000;

const quiet = (minutesAgo: number): PodActivity => ({
  midTurn: false,
  openRequest: false,
  lastActivityAt: NOW - minutesAgo * MINUTE,
});

const waiting = [{ projectId: 'prj_sweetums', createdAt: NOW - 30 * MINUTE }];

describe('the idle project switch', () => {
  it('switches only after 5 idle minutes with another project waiting', () => {
    expect(decideSwitch({ now: NOW, activity: [quiet(6)], waiting })).toBe(
      'prj_sweetums'
    );
    expect(
      decideSwitch({ now: NOW, activity: [quiet(4)], waiting })
    ).toBeNull();
    expect(
      decideSwitch({ now: NOW, activity: [quiet(60)], waiting: [] })
    ).toBeNull();
    expect(IDLE_MS).toBe(5 * MINUTE);
  });

  it('never switches with an agent mid-turn or a request queued', () => {
    expect(
      decideSwitch({
        now: NOW,
        activity: [quiet(60), { ...quiet(60), midTurn: true }],
        waiting,
      })
    ).toBeNull();
    expect(
      decideSwitch({
        now: NOW,
        activity: [{ ...quiet(60), openRequest: true }],
        waiting,
      })
    ).toBeNull();
    expect(idleSince([{ ...quiet(1), midTurn: true }])).toBeNull();
  });

  it('counts from the latest turn end or request change', () => {
    expect(idleSince([quiet(20), quiet(3)])).toBe(NOW - 3 * MINUTE);
    expect(
      decideSwitch({ now: NOW, activity: [quiet(20), quiet(3)], waiting })
    ).toBeNull();
  });

  it("counts an empty project's idleness from when the runner arrived on it", () => {
    // No pods yet: the 5 minutes run from the arrival, not from the epoch.
    expect(
      decideSwitch({
        now: NOW,
        activity: [],
        arrivedAt: NOW - 4 * MINUTE,
        waiting,
      })
    ).toBeNull();
    expect(
      decideSwitch({
        now: NOW,
        activity: [],
        arrivedAt: NOW - 6 * MINUTE,
        waiting,
      })
    ).toBe('prj_sweetums');
    expect(idleSince([quiet(20)], NOW - 3 * MINUTE)).toBe(NOW - 3 * MINUTE);
  });

  it('takes the project whose oldest waiting pod is oldest', () => {
    expect(
      decideSwitch({
        now: NOW,
        activity: [],
        waiting: [
          { projectId: 'prj_new', createdAt: NOW - 2 * MINUTE },
          { projectId: 'prj_old', createdAt: NOW - 40 * MINUTE },
          { projectId: 'prj_new', createdAt: NOW - 50 * MINUTE },
        ],
      })
    ).toBe('prj_new');
  });

  it('stops, then starts (which resumes the pods), then starts each waiting pod', async () => {
    const log: { calls: string[] } = { calls: [] };
    const call = (line: string): void => {
      log.calls = [...log.calls, line];
    };
    const ids = await runSwitch(
      {
        stop: async (folder) => {
          call(`stop ${folder}`);
        },
        start: async (folder) => {
          call(`start ${folder}`);
          // lambda start ends with lambda pod resume-all.
          call(`resume-all ${folder}`);
        },
        newPod: async (folder, intake) => {
          call(`new ${folder} ${intake.text}`);

          return 'nougat-tracker';
        },
        report: (state) =>
          call(`report ${state.folder} ${String(state.switching)}`),
      },
      '/home/leslie/pawnee-parks',
      '/home/leslie/sweetums',
      [{ text: 'Nougat tracker', freeform: true, single: false }]
    );

    expect(ids).toEqual(['nougat-tracker']);
    expect(log.calls).toEqual([
      'report /home/leslie/pawnee-parks /home/leslie/sweetums',
      'stop /home/leslie/pawnee-parks',
      'start /home/leslie/sweetums',
      'resume-all /home/leslie/sweetums',
      'new /home/leslie/sweetums Nougat tracker',
      'report /home/leslie/sweetums null',
    ]);
  });

  it('reports where the runner really is when a switch fails', async () => {
    const reports = async (failAt: 'stop' | 'start' | 'new') => {
      const seen: { last: string | null } = { last: null };
      const fail = (step: string) => async () => {
        if (step === failAt) {
          throw new Error(`${step} failed`);
        }
      };

      await expect(
        runSwitch(
          {
            stop: fail('stop'),
            start: fail('start'),
            newPod: async () => {
              await fail('new')();

              return 'nougat-tracker';
            },
            report: (state) => {
              seen.last = `${String(state.folder)} ${String(state.switching)}`;
            },
          },
          '/home/leslie/pawnee-parks',
          '/home/leslie/sweetums',
          [{ text: 'Nougat tracker', freeform: true, single: false }]
        )
      ).rejects.toThrow(`${failAt} failed`);

      return seen.last;
    };

    // Stop failed: still on the old project.
    expect(await reports('stop')).toBe('/home/leslie/pawnee-parks null');
    // Stopped, but the new one didn't start: on no project.
    expect(await reports('start')).toBe('null null');
    // Started; only the pod failed: on the new project.
    expect(await reports('new')).toBe('/home/leslie/sweetums null');
  });

  it('names the busy computer and its project while a pod waits', () => {
    expect(waitingLabel("Leslie's MacBook", 'Pawnee Parks site')).toBe(
      "Waiting: Leslie's MacBook is busy on Pawnee Parks site"
    );
  });
});
