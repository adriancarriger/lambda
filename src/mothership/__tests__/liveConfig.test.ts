import type { MachineConfig } from '../../config/machineConfig';
import { liveConfig } from '../liveConfig';

const START: MachineConfig = { owner: { name: 'Leslie Knope' } };

describe('the config the mothership re-reads', () => {
  it('falls back to the one read at start, saying why once per reason', () => {
    const said: { lines: string[] } = { lines: [] };
    const outcome: { error: Error | null } = {
      error: new Error('Unexpected token } in JSON'),
    };
    const read = liveConfig({
      load: () => {
        if (outcome.error !== null) {
          throw outcome.error;
        }

        return { owner: { name: 'Ben Wyatt' } };
      },
      fallback: START,
      log: (line) => {
        said.lines = [...said.lines, line];
      },
    });

    expect(read()).toBe(START);
    expect(read()).toBe(START);
    expect(said.lines).toEqual([
      "~/.lambda/config.json can't be read (Unexpected token } in JSON); using the one read at start.",
    ]);

    outcome.error = new Error('owner.name: Required');
    read();

    expect(said.lines).toHaveLength(2);

    outcome.error = null;

    expect(read()).toEqual({ owner: { name: 'Ben Wyatt' } });

    outcome.error = new Error('owner.name: Required');
    read();

    expect(said.lines).toHaveLength(3);
  });
});
