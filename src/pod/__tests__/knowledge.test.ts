import * as fs from 'fs';
import * as path from 'path';

import { makeKnowledgeEntry, writeKnowledgeFile } from '../../pod-store';
import { runKnowledgeAdd, runKnowledgeList } from '../knowledge';
import { usePodProject } from './podProject';

const saved = { ...process.env };

const ADD = {
  kind: 'judgement',
  statement: 'Every park page shows its opening hours.',
  why: 'People plan their visits around the hours.',
};

const jsonFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    : [];

beforeEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...saved };
  jest.restoreAllMocks();
});

describe('lambda knowledge', () => {
  it('add writes to <pods root>/_knowledge/ by default', () => {
    const root = usePodProject();

    runKnowledgeAdd(ADD);

    expect(
      jsonFiles(path.join(root, '.lambda', 'pods', '_knowledge', 'judgements'))
    ).toHaveLength(1);
  });

  it('add writes to knowledge.local when lambda.json sets it', () => {
    const root = usePodProject({ knowledge: { local: 'notes/mine' } });

    runKnowledgeAdd(ADD);

    expect(
      jsonFiles(path.join(root, 'notes', 'mine', 'judgements'))
    ).toHaveLength(1);
    expect(
      jsonFiles(path.join(root, '.lambda', 'pods', '_knowledge', 'judgements'))
    ).toEqual([]);
  });

  it("list reads the shared store from .lambda/knowledge/, and never a folder Lambda doesn't own", () => {
    const root = usePodProject();
    const shared = makeKnowledgeEntry({
      kind: 'judgement',
      statement: 'The dog park closes at dusk.',
      why: 'The lights are off after dark.',
    });
    const elsewhere = makeKnowledgeEntry({
      kind: 'judgement',
      statement: 'Ice Town is open all winter.',
      why: 'It is an indoor rink.',
    });
    writeKnowledgeFile(path.join(root, '.lambda', 'knowledge'), shared);
    writeKnowledgeFile(path.join(root, '.other-pods', '_knowledge'), elsewhere);
    const printed: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.splice(printed.length, 0, line);
    });

    runKnowledgeList({ json: true });

    const listed = JSON.parse(printed.join('\n')).map(
      (entry: { statement: string }) => entry.statement
    );
    expect(listed).toEqual(['The dog park closes at dusk.']);
  });
});
