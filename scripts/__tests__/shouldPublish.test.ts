import { NOT_ON_NPM, parseNpmView, shouldPublish } from '../shouldPublish';

describe('whether a push publishes', () => {
  it('publishes only a version npm does not have', () => {
    expect(shouldPublish('0.3.0', ['0.1.0', '0.2.0'])).toBe(true);
    expect(shouldPublish('0.2.0', ['0.1.0', '0.2.0'])).toBe(false);
  });

  it('publishes when the package is not on npm at all (E404)', () => {
    const versions = parseNpmView(
      1,
      '',
      'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x'
    );

    expect(versions).toBe(NOT_ON_NPM);
    expect(shouldPublish('0.1.0', versions)).toBe(true);
  });

  it('reads one version (a string) or many (an array)', () => {
    expect(parseNpmView(0, '"0.1.0"\n', '')).toEqual(['0.1.0']);
    expect(parseNpmView(0, '["0.1.0","0.2.0"]\n', '')).toEqual([
      '0.1.0',
      '0.2.0',
    ]);
  });

  it('fails loudly on any other npm failure', () => {
    expect(() => parseNpmView(1, '', 'npm error code ETIMEDOUT')).toThrow(
      'npm view failed (1): npm error code ETIMEDOUT'
    );
  });
});
