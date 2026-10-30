import * as fs from 'fs';
import * as path from 'path';

import { lambdaHome, loadMachineConfig } from '../config/machineConfig';
import { createRunnerProcess } from './process';

/**
 * The runner process: `node dist/runner.js`, a login service on a joined
 * computer (or a `lambda-system` window on the host). One outgoing socket to
 * the mothership; it runs this computer's pods.
 */

const log = (line: string) =>
  console.error(`[${new Date().toISOString()}] ${line}`);

const main = (): void => {
  const config = loadMachineConfig();
  const runnerId = config?.runner?.id;
  const keyPath = config?.runner?.keyPath;

  if (runnerId === undefined || keyPath === undefined) {
    throw new Error(
      "This computer isn't part of a Lambda. Run lambda join <code> first."
    );
  }

  const home = lambdaHome();
  const { runtime, client, status } = createRunnerProcess({
    config,
    runnerId,
    privateKey: fs.readFileSync(keyPath, 'utf8'),
    log,
  });

  fs.writeFileSync(path.join(home, 'runner.pid'), String(process.pid), {
    mode: 0o600,
  });
  status(false);
  client.start();

  const building = { running: false };
  const timers = [
    setInterval(() => {
      runtime.pollCurrent().catch((error: unknown) => log(String(error)));
    }, 1000),
    // Building pods: a tick is cheap; pick-up and stalls keep their own pace.
    setInterval(() => {
      if (building.running) {
        return;
      }

      building.running = true;
      runtime
        .tickBuilding()
        .catch((error: unknown) => log(`building: ${String(error)}`))
        .finally(() => {
          building.running = false;
        });
    }, 5000),
    setInterval(() => {
      try {
        runtime.scanEvents(runtime.cursorFile());
      } catch (error) {
        log(`events: ${String(error)}`);
      }
    }, 2000),
  ];

  const stop = () => {
    timers.forEach((timer) => clearInterval(timer));
    client.stop();
    runtime.dispose();
    status(false);
    fs.rmSync(path.join(home, 'runner.pid'), { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
