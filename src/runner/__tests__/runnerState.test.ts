import * as fs from 'fs';
import * as path from 'path';

import {
  type Harness,
  eventually,
  holdProject,
  startHarness,
  tempHome,
} from '../../mothership/__tests__/harness';
import { addRunner, getRunner, newRunnerId } from '../../mothership/registry';
import { createRunnerClient } from '../client';
import { generateRunnerKeys } from '../keys';
import { createOutbox } from '../outbox';

const FOLDER = '/home/leslie/mac-mini/pawnee-parks';

describe('runner-state through the outbox', () => {
  it('is acknowledged, so it leaves the outbox once it has arrived', async () => {
    const harness: Harness = await startHarness();
    const home = tempHome();
    const keys = generateRunnerKeys();
    const runnerId = newRunnerId();
    addRunner(
      harness.db,
      { id: runnerId, name: "Leslie's Mac mini", publicKey: keys.publicKey },
      1
    );
    const projectId = holdProject(harness, runnerId, {
      folder: FOLDER,
      current: false,
    });
    const outbox = createOutbox(path.join(home, 'outbox.jsonl'));
    const client = createRunnerClient({
      url: `http://127.0.0.1:${harness.port}`,
      runnerId,
      privateKey: keys.privateKey,
      outbox,
      handle: async () => null,
      log: () => undefined,
    });

    client.enqueue({
      type: 'runner-state',
      id: 'st1',
      folder: FOLDER,
      switching: null,
    });
    client.start();

    await eventually(
      () => getRunner(harness.db, runnerId)?.currentProjectId === projectId
    );
    await eventually(() => outbox.pending().length === 0);

    expect(outbox.pending()).toEqual([]);
    client.stop();
    await harness.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
