import {
  AUTOSAVE_PAUSE_MS,
  createAutosave,
  tidyMarkdown,
} from '../shared/autosave';

/** A description saves itself as you type, the way Linear's does. */

const setUp = (initial = 'Old words.', fail = false) => {
  const timers: Array<{ run: () => void; at: number; live: boolean }> = [];
  const clock = { now: 0 };
  const saves: string[] = [];
  const pending: Array<() => void> = [];
  const autosave = createAutosave(
    initial,
    (text) =>
      new Promise<void>((resolve, reject) => {
        saves.splice(saves.length, 0, text);
        pending.splice(pending.length, 0, () =>
          fail ? reject(new Error('offline')) : resolve()
        );
      }),
    {
      set: (run, ms) => {
        const timer = { run, at: clock.now + ms, live: true };
        timers.splice(timers.length, 0, timer);

        return timer;
      },
      clear: (handle) => {
        const timer = timers.find((one) => one === handle);

        if (timer !== undefined) {
          timer.live = false;
        }
      },
    }
  );
  const pass = (ms: number): void => {
    clock.now += ms;
    timers
      .filter((timer) => timer.live && timer.at <= clock.now)
      .forEach((timer) => {
        timer.live = false;
        timer.run();
      });
  };
  const settle = async (): Promise<void> => {
    pending.splice(0).forEach((done) => done());
    await new Promise((resolve) => setImmediate(resolve));
  };

  return { autosave, saves, pass, settle };
};

describe('saving a description as you type', () => {
  it('saves once typing pauses, with the newest text', () => {
    const { autosave, saves, pass } = setUp();
    autosave.changed('O');
    pass(300);
    autosave.changed('One');
    pass(AUTOSAVE_PAUSE_MS - 1);

    expect(saves).toEqual([]);

    pass(1);

    expect(saves).toEqual(['One']);
  });

  it('saves at once on leaving the box, and nothing when nothing changed', async () => {
    const { autosave, saves, pass, settle } = setUp();
    autosave.changed('Old words.');
    autosave.flush();
    pass(AUTOSAVE_PAUSE_MS);

    expect(saves).toEqual([]);

    autosave.changed('New words.');
    autosave.flush();
    await settle();

    expect(saves).toEqual(['New words.']);
    expect(autosave.busy()).toBe(false);
  });

  it('sends what was typed during a save once that save is back', async () => {
    const { autosave, saves, pass, settle } = setUp();
    autosave.changed('First');
    pass(AUTOSAVE_PAUSE_MS);
    autosave.changed('Second');
    autosave.flush();

    // One save at a time.
    expect(saves).toEqual(['First']);

    await settle();

    expect(saves).toEqual(['First', 'Second']);
  });

  it('keeps a failed save to try again, and reads as busy meanwhile', async () => {
    const { autosave, saves, pass, settle } = setUp('Old words.', true);
    autosave.changed('New words.');
    pass(AUTOSAVE_PAUSE_MS);
    await settle();

    expect(saves).toEqual(['New words.']);
    expect(autosave.busy()).toBe(true);
  });
});

describe("the editor's Markdown, tidied", () => {
  it('keeps bare links and emails bare, and one blank line between blocks', () => {
    expect(
      tidyMarkdown(
        'Write [parks@pawnee.gov](mailto:parks@pawnee.gov) or see [https://pawnee.gov](https://pawnee.gov) and [the site](https://pawnee.gov).\n\n\n| a |\n'
      )
    ).toBe(
      'Write parks@pawnee.gov or see https://pawnee.gov and [the site](https://pawnee.gov).\n\n| a |'
    );
  });
});
