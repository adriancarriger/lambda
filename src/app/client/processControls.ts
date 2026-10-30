import { type LoadTarget, latestLoader } from './loading';

/**
 * Settings → Process's reads and switches, through one loader: a read that
 * started before a switch and answers after it is dropped, so the switch
 * stays where it was flipped; and a switch that lands clears an old error.
 * A switch goes to the computer and back (up to 60 s): `busy` is true for
 * that long, so the page can hold the switches still.
 */
export const processControls = <T>(
  io: {
    read: (projectId: string) => Promise<T>;
    flip: (
      projectId: string,
      process: 'planning' | 'building',
      step: string,
      on: boolean
    ) => Promise<T>;
  },
  target: LoadTarget<T> & { busy?: (busy: boolean) => void }
) => {
  const load = latestLoader(target);
  const flips = { inFlight: 0 };

  return {
    read: (projectId: string) => load(io.read(projectId)),
    flip: async (
      projectId: string,
      process: 'planning' | 'building',
      step: string,
      on: boolean
    ) => {
      flips.inFlight += 1;
      target.busy?.(true);

      try {
        await load(io.flip(projectId, process, step, on));
      } finally {
        flips.inFlight -= 1;
        target.busy?.(flips.inFlight > 0);
      }
    },
  };
};

/**
 * Whether a heartbeat reads the settings again. Only after an error (the
 * computer was offline: it comes back on its own), and never over a flip on
 * its way, whose answer the newer read would drop.
 */
export const rereadsOnTick = (now: {
  error: string | null;
  busy: boolean;
}): boolean => now.error !== null && !now.busy;
