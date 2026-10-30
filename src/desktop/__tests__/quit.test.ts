import { createQuitController } from '../quit';

const event = () => {
  const seen = { prevented: false };

  return {
    seen,
    preventDefault: () => {
      seen.prevented = true;
    },
  };
};

const setup = () => {
  const order: string[] = [];
  const controller = createQuitController({
    stopLambda: async () => {
      order.splice(order.length, 0, 'stop');
    },
    quit: () => {
      order.splice(order.length, 0, 'quit');
    },
    install: () => {
      order.splice(order.length, 0, 'install');
    },
  });

  return { controller, order };
};

describe('ending the Mac app', () => {
  it('hides the window on close while the app keeps running', () => {
    const { controller } = setup();
    const close = event();

    expect(controller.windowClose(close)).toBe('hide');
    expect(close.seen.prevented).toBe(true);
  });

  it('Quit stops Lambda, then quits the ordinary way, which then goes through', async () => {
    const { controller, order } = setup();

    await controller.quit();
    const beforeQuit = event();
    controller.beforeQuit(beforeQuit);
    const close = event();

    expect(order).toEqual(['stop', 'quit']);
    // Not held back: electron-updater installs a downloaded update on quit.
    expect(beforeQuit.seen.prevented).toBe(false);
    expect(controller.windowClose(close)).toBe('close');
    expect(close.seen.prevented).toBe(false);
  });

  it('Cmd-Q stops Lambda first, then quits', async () => {
    const { controller, order } = setup();
    const first = event();

    controller.beforeQuit(first);
    await new Promise((resolve) => setImmediate(resolve));

    expect(first.seen.prevented).toBe(true);
    expect(order).toEqual(['stop', 'quit']);
  });

  it('Restart to update stops Lambda, installs, and lets the window close and the app quit', async () => {
    const { controller, order } = setup();

    await controller.restartToUpdate();
    const close = event();
    const beforeQuit = event();

    expect(order).toEqual(['stop', 'install']);
    expect(controller.windowClose(close)).toBe('close');
    expect(close.seen.prevented).toBe(false);
    controller.beforeQuit(beforeQuit);
    expect(beforeQuit.seen.prevented).toBe(false);
  });

  it('a second Cmd-Q while Lambda is stopping waits for that stop instead of starting another', async () => {
    const order: string[] = [];
    const pending: { finish: () => void } = { finish: () => undefined };
    const controller = createQuitController({
      stopLambda: () =>
        new Promise<void>((resolve) => {
          order.splice(order.length, 0, 'stop');
          pending.finish = resolve;
        }),
      quit: () => {
        order.splice(order.length, 0, 'quit');
      },
      install: () => undefined,
    });
    const first = event();
    const second = event();

    controller.beforeQuit(first);
    controller.beforeQuit(second);
    pending.finish();
    await new Promise((resolve) => setImmediate(resolve));

    expect(second.seen.prevented).toBe(true);
    expect(order).toEqual(['stop', 'quit', 'quit']);
  });

  it('lets a shut-down or log-out quit straight through: holding it back would cancel it', () => {
    const { controller, order } = setup();
    const beforeQuit = event();

    controller.shutdown();
    controller.beforeQuit(beforeQuit);

    expect(beforeQuit.seen.prevented).toBe(false);
    expect(order).toEqual([]);
    expect(controller.windowClose(event())).toBe('close');
  });

  it('lets the window close once electron-updater is quitting to install', () => {
    const { controller } = setup();

    controller.quittingForUpdate();

    expect(controller.windowClose(event())).toBe('close');
  });
});
