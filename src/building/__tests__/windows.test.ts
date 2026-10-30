import { podWindowsOf } from '../windows';

/**
 * In a project's shared tmux session only the windows tagged with the pod's
 * id are its own: a project's `product-manager` or `ask-…` is left alone.
 */
describe("a building pod's windows in a shared session", () => {
  it('are the ones tagged with its id, whatever they are called', () => {
    const listing = [
      'scratchPad\t',
      'product-manager\t',
      'ask-notes\t',
      'dev\tbuild-1',
      'product-manager\tbuild-1',
      'ask-t1\tbuild-1',
      'qa\tbuild-2',
    ].join('\n');

    expect(podWindowsOf(listing, 'build-1')).toEqual([
      'dev',
      'product-manager',
      'ask-t1',
    ]);
  });
});
