import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  activeKnowledge,
  classifyNew,
  knowledgeId,
  makeKnowledgeEntry,
  readKnowledge,
  syncKnowledge,
  writeKnowledgeFile,
} from '../knowledge';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-'));

const judgement = (statement: string, extra: Record<string, unknown> = {}) =>
  makeKnowledgeEntry({
    kind: 'judgement',
    statement,
    why: 'Hikers trust what the map shows them.',
    createdAt: '2026-10-07T10:00:00.000Z',
    ...extra,
  });

describe('knowledge ids', () => {
  it('ignore case, spacing, punctuation and quotes — and differ by kind', () => {
    expect(knowledgeId('judgement', 'Trails close only at dusk.')).toBe(
      knowledgeId('judgement', '  trails CLOSE only at “dusk” ')
    );
    expect(knowledgeId('copy', 'Say marker')).not.toBe(
      knowledgeId('judgement', 'Say marker')
    );
  });
});

describe('duplicates are caught by code', () => {
  const known = [judgement('A closed trail stays on the map, greyed out.')];

  it('an exact (normalized) match is the same entry', () => {
    expect(
      classifyNew(
        judgement('a closed trail stays on the map greyed out'),
        known
      ).status
    ).toBe('exists');
  });

  it('a near-duplicate is refused, naming the one it repeats', () => {
    const verdict = classifyNew(
      judgement('A closed trail stays on the map, greyed out too.'),
      known
    );

    expect(verdict.status).toBe('near-duplicate');
  });

  it('a different judgement is added', () => {
    expect(
      classifyNew(judgement('Never call a picnic group a party.'), known).status
    ).toBe('added');
  });

  it('a rewording that supersedes the old one is allowed, and replaces it', () => {
    const [old] = known;
    const reworded = judgement(
      'A closed trail stays on the map, greyed out, never hidden.',
      { supersedes: [old?.id ?? ''] }
    );

    expect(classifyNew(reworded, known).status).toBe('added');
    expect(
      activeKnowledge([...known, reworded]).map((entry) => entry.id)
    ).toEqual([reworded.id]);
  });
});

describe('contradicting copy rules are refused', () => {
  const rule = (statement: string, use: string, never: string[], extra = {}) =>
    makeKnowledgeEntry({
      kind: 'copy',
      statement,
      why: 'One name everywhere.',
      copy: { use, never, meaning: 'a post that marks a trail' },
      createdAt: '2026-10-07T10:00:00.000Z',
      ...extra,
    });
  const primary = rule('Say marker, never signpost.', 'marker', ['signpost']);

  it('using a term another rule bans is a conflict (word overlap would miss it)', () => {
    expect(
      classifyNew(rule('Say signpost instead of marker.', 'signpost', []), [
        primary,
      ]).status
    ).toBe('conflict');
  });

  it("banning another rule's term is a conflict too", () => {
    expect(
      classifyNew(rule('Say waypoint.', 'waypoint', ['Marker']), [primary])
        .status
    ).toBe('conflict');
  });

  it('…unless it says it replaces that rule', () => {
    expect(
      classifyNew(
        rule('Say signpost now.', 'signpost', [], {
          supersedes: [primary.id],
        }),
        [primary]
      ).status
    ).toBe('added');
  });
});

describe('syncKnowledge — what runs at commit', () => {
  it('copies only new entries, never edits or deletes a shared file', () => {
    const local = tmp();
    const shared = tmp();
    const kept = judgement('Never call a picnic group a party.');
    const fresh = judgement('A closed trail stays on the map, greyed out.');
    writeKnowledgeFile(shared, kept);
    const sharedFile = path.join(shared, 'judgements', `${kept.id}.json`);
    // Someone hand-edited the shared copy: the sync must not touch it.
    fs.writeFileSync(
      sharedFile,
      fs.readFileSync(sharedFile, 'utf8').replace('party', 'PARTY')
    );
    const before = fs.readFileSync(sharedFile, 'utf8');
    writeKnowledgeFile(local, kept);
    writeKnowledgeFile(local, fresh);

    const result = syncKnowledge(local, shared);

    expect(result.added.map((entry) => entry.id)).toEqual([fresh.id]);
    expect(fs.readFileSync(sharedFile, 'utf8')).toBe(before);
    expect(
      readKnowledge(shared)
        .map((entry) => entry.id)
        .sort()
    ).toEqual([kept.id, fresh.id].sort());
  });

  it('skips a near-duplicate of a shared entry (another machine said it first)', () => {
    const local = tmp();
    const shared = tmp();
    writeKnowledgeFile(
      shared,
      judgement('A closed trail stays on the map, greyed out.')
    );
    writeKnowledgeFile(
      local,
      judgement('A closed trail stays on the map, greyed out too.')
    );

    const result = syncKnowledge(local, shared);

    expect(result.added).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/near-duplicate/);
  });

  it('two machines adding the same entry write the identical file (no conflict)', () => {
    const machineA = tmp();
    const machineB = tmp();
    const entry = judgement('Never call a picnic group a party.');
    writeKnowledgeFile(machineA, entry);
    writeKnowledgeFile(machineB, { ...entry });

    expect(
      fs.readFileSync(
        path.join(machineA, 'judgements', `${entry.id}.json`),
        'utf8'
      )
    ).toBe(
      fs.readFileSync(
        path.join(machineB, 'judgements', `${entry.id}.json`),
        'utf8'
      )
    );
  });
});
