import { podFileRequestOf } from '../podFiles';

/** A `pod-file` message is read by its shape, never by String() on a gap. */
describe('a pod-file request from the mothership', () => {
  it('reads its pod, folder and path', () => {
    expect(
      podFileRequestOf({
        type: 'pod-file',
        podId: 'build-1',
        folder: 'screenshots',
        path: '3/1/a.png',
      })
    ).toEqual({ podId: 'build-1', folder: 'screenshots', path: '3/1/a.png' });
  });

  it.each([
    [{ type: 'pod-file', folder: 'screenshots', path: 'a.png' }],
    [{ type: 'pod-file', podId: 7, folder: 'screenshots', path: 'a.png' }],
    [{ type: 'pod-file', podId: 'build-1', folder: 'screenshots' }],
  ])('refuses one with a part missing or not text: %j', (message) => {
    expect(() => podFileRequestOf(message)).toThrow(
      'A pod-file request needs a podId, a folder and a path.'
    );
  });
});
