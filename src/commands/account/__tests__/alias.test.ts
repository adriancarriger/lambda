import * as fs from 'fs';
import * as path from 'path';

import { EMPTY_ALIAS, NOT_ON_HOST, addAlias, aliasList, removeAlias } from '..';
import { required } from '../../../__tests__/required';
import { writeMachineConfig } from '../../../config/machineConfig';
import { tempHome } from '../../../mothership/__tests__/harness';
import { openDb } from '../../../mothership/db';

describe('lambda account alias', () => {
  const fixture: { home?: string; env?: Record<string, string> } = {};
  const home = (): string => required(fixture.home, 'home');
  const env = (): Record<string, string> => required(fixture.env, 'env');

  beforeEach(() => {
    fixture.home = tempHome();
    fixture.env = { LAMBDA_HOME: home() };
    writeMachineConfig(
      { owner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' } },
      env()
    );
  });

  afterEach(() => fs.rmSync(home(), { recursive: true, force: true }));

  const rows = () => {
    const db = openDb(path.join(home(), 'mothership.db'));
    const all = db.prepare('SELECT kind, value FROM aliases ORDER BY id').all();
    db.close();

    return all;
  };

  it('adds, repeats safely, lists and removes', () => {
    expect(addAlias('LKnope@Pawnee.gov', env())).toBe(
      '✓ lknope@pawnee.gov now counts as Leslie Knope'
    );
    expect(addAlias('LKnope@Pawnee.gov', env())).toBe(
      'lknope@pawnee.gov already counts as Leslie Knope.'
    );
    expect(rows()).toEqual([{ kind: 'email', value: 'lknope@pawnee.gov' }]);

    expect(addAlias('Knope', env())).toBe('✓ knope now counts as Leslie Knope');
    expect(rows()).toEqual([
      { kind: 'email', value: 'lknope@pawnee.gov' },
      { kind: 'name', value: 'knope' },
    ]);
    expect(aliasList(env())).toEqual([
      'Aliases for Leslie Knope',
      '  email  lknope@pawnee.gov',
      '  name   knope',
    ]);

    expect(removeAlias('Knope', env())).toBe(
      '✓ knope no longer counts as Leslie Knope'
    );
    expect(() => removeAlias('Knope', env())).toThrow(
      "knope isn't an alias of Leslie Knope."
    );
  });

  it('treats the owner’s own email as already counting, writing nothing', () => {
    expect(addAlias('Leslie@Pawnee.gov', env())).toBe(
      'leslie@pawnee.gov already counts as Leslie Knope.'
    );
    expect(rows()).toEqual([]);
  });

  it('says so when there are none, and refuses an empty value', () => {
    expect(aliasList(env())).toEqual(['No aliases.']);
    expect(() => addAlias('  ', env())).toThrow(EMPTY_ALIAS);
  });

  it('only runs on the computer running Lambda, writing nothing elsewhere', () => {
    writeMachineConfig(
      {
        owner: { name: 'Leslie Knope' },
        mothership: { url: 'http://100.64.0.2:4580' },
      },
      env()
    );

    expect(() => addAlias('knope', env())).toThrow(NOT_ON_HOST);
    expect(fs.existsSync(path.join(home(), 'mothership.db'))).toBe(false);
  });

  it('keeps one row per kind and value, even inserted directly', () => {
    const db = openDb(path.join(home(), 'mothership.db'));
    const insert = db.prepare(
      "INSERT INTO aliases (kind, value, created_at) VALUES ('name', 'knope', 1)"
    );
    insert.run();

    expect(() => insert.run()).toThrow(/UNIQUE/);
    db.close();
  });
});
