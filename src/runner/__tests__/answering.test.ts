import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import { runCli } from '../../__tests__/runCli';
import { NOT_RUNNING, NOT_THE_HOST, runOpen } from '../../commands/open';
import { mothershipUp } from '../../commands/start';
import { writeMachineConfig } from '../../config/machineConfig';
import { startHarness, tempHome } from '../../mothership/__tests__/harness';
import { answering } from '../processes';

/** Some other web server holding the port: it answers, but it isn't Lambda. */
const foreignServer = async (): Promise<{
  port: number;
  close: () => Promise<void>;
}> => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<h1>Someone else</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const PORT_IN_USE = (port: number) =>
  `Can't listen on 127.0.0.1:${port}: the port is in use. Set mothership.port in ~/.lambda/config.json.`;

describe('telling the mothership from another server on its port', () => {
  const opened: { cleanups: (() => Promise<void> | void)[] } = {
    cleanups: [],
  };
  const later = (cleanup: () => Promise<void> | void): void => {
    opened.cleanups = [...opened.cleanups, cleanup];
  };

  afterEach(async () => {
    const { cleanups } = opened;
    opened.cleanups = [];
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  });

  const temp = (): string => {
    const home = tempHome();
    later(() => fs.rmSync(home, { recursive: true, force: true }));

    return home;
  };

  const other = async () => {
    const server = await foreignServer();
    later(server.close);

    return server;
  };

  it('counts the mothership, not some other server answering there', async () => {
    const harness = await startHarness();
    later(harness.close);
    const foreign = await other();

    expect(await answering(harness.port)).toBe(true);
    expect(await answering(foreign.port)).toBe(false);
  });

  it("lambda start reports the mothership's port-in-use line when another server holds the port", async () => {
    const foreign = await other();
    const home = temp();
    // What the mothership writes as it exits 1 (mothership/main.ts).
    fs.writeFileSync(
      path.join(home, 'mothership.log'),
      `${PORT_IN_USE(foreign.port)}\n`
    );

    const failure = await mothershipUp({
      port: foreign.port,
      home,
      isRunning: () => false,
      timeoutMs: 10_000,
    });

    expect(failure).toBe(PORT_IN_USE(foreign.port));
  });

  it("lambda open mints no link against another server: Lambda isn't running", async () => {
    const foreign = await other();
    const home = temp();
    const env = { LAMBDA_HOME: home };
    writeMachineConfig({ mothership: { port: foreign.port } }, env);
    const open = jest.fn();

    await expect(runOpen({ env, answering, open })).rejects.toThrow(
      NOT_RUNNING
    );
    expect(open).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, 'mothership.db'))).toBe(false);
  });

  it('lambda open prints only its refusal when it refuses', async () => {
    const home = temp();
    writeMachineConfig(
      { mothership: { url: 'http://100.64.0.2:4580' } },
      { LAMBDA_HOME: home }
    );

    const result = await runCli(['open'], { LAMBDA_HOME: home });

    expect(result).toEqual({ code: 1, out: '', err: NOT_THE_HOST });
  });
});
