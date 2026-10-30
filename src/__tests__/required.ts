/**
 * A value a `beforeEach` sets for each test. Tests keep such values on a
 * holder object (no `let`) and read them through this, which fails loudly if
 * one is read before the hook ran.
 */
export const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) {
    throw new Error(`${name} is set in beforeEach; read it inside a test.`);
  }

  return value;
};
