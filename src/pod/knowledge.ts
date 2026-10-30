import { type Project, resolveKnowledgeDirs } from '../config/projectConfig';
import {
  KNOWLEDGE_KINDS,
  type KnowledgeEntry,
  type KnowledgeKind,
  activeKnowledge,
  classifyNew,
  makeKnowledgeEntry,
  mergeKnowledge,
  readKnowledge,
  spokenTextProblems,
  syncKnowledge,
  writeKnowledgeFile,
} from '../pod-store';
import { currentProject } from './context';

/**
 * `lambda knowledge add | list | sync` — the owner's long-term judgements and
 * copy rules (see pod-store/knowledge.ts). Two stores:
 *   - local: this machine's, `<pods root>/_knowledge/` (lambda.json
 *     `knowledge.local`); `add` writes it instantly;
 *   - shared: checked in, `<project>/.lambda/knowledge/` (lambda.json
 *     `knowledge.shared`); `sync` copies new local entries into it.
 */

export const knowledgeDirs = (
  project: Project = currentProject()
): { local: string; shared: string } => resolveKnowledgeDirs(project);

/** Everything that counts now: checked-in + this machine's, minus superseded. */
export const currentKnowledge = (
  project: Project = currentProject()
): KnowledgeEntry[] => {
  const { local, shared } = knowledgeDirs(project);

  return activeKnowledge(
    mergeKnowledge(readKnowledge(shared), readKnowledge(local))
  );
};

const isKind = (value: string): value is KnowledgeKind =>
  KNOWLEDGE_KINDS.some((kind) => kind === value);

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

export const runKnowledgeAdd = (options: {
  kind: string;
  statement: string;
  why: string;
  quote?: string;
  use?: string;
  never?: string;
  meaning?: string;
  source?: string;
  supersedes?: string;
}): void => {
  if (!isKind(options.kind)) {
    throw new Error(`--kind must be ${KNOWLEDGE_KINDS.join(' or ')}.`);
  }

  const problems = [
    ...spokenTextProblems(options.statement, 'the statement'),
    ...spokenTextProblems(options.why, 'why'),
    ...(options.kind === 'copy' &&
    (options.use === undefined || options.meaning === undefined)
      ? [
          'A copy rule needs --use "<the term>" and --meaning "<what it means>" (and --never "a, b" for terms to avoid).',
        ]
      : []),
  ];

  if (problems.length > 0) {
    throw new Error(`Not added:\n  • ${problems.join('\n  • ')}`);
  }

  const entry = makeKnowledgeEntry({
    kind: options.kind,
    statement: options.statement.trim(),
    why: options.why.trim(),
    quote: options.quote?.trim(),
    source: options.source,
    supersedes:
      list(options.supersedes).length === 0
        ? undefined
        : list(options.supersedes),
    copy:
      options.kind === 'copy' &&
      options.use !== undefined &&
      options.meaning !== undefined
        ? {
            use: options.use.trim(),
            never: list(options.never),
            meaning: options.meaning.trim(),
          }
        : undefined,
  });
  const { local, shared } = knowledgeDirs();
  const known = mergeKnowledge(readKnowledge(shared), readKnowledge(local));
  const verdict = classifyNew(entry, known);

  if (verdict.status === 'exists') {
    console.log(`Already known (${verdict.entry.id}).`);

    return;
  }

  if (verdict.status === 'conflict') {
    throw new Error(
      `Contradicts ${verdict.of.id}: "${verdict.of.statement}". To change that rule, add this with --supersedes ${verdict.of.id}.`
    );
  }

  if (verdict.status === 'near-duplicate') {
    throw new Error(
      `Too close to ${verdict.of.id}: "${verdict.of.statement}". To change it, add the new wording with --supersedes ${verdict.of.id}.`
    );
  }

  writeKnowledgeFile(local, entry);
  console.log(
    `Added ${entry.kind} ${entry.id} (shared with every machine on the next lambda knowledge sync).`
  );
};

export const runKnowledgeList = (options: {
  kind?: string;
  json?: boolean;
}): void => {
  const entries = currentKnowledge().filter(
    (entry) => options.kind === undefined || entry.kind === options.kind
  );

  if (options.json === true) {
    console.log(JSON.stringify(entries, null, 2));

    return;
  }

  if (entries.length === 0) {
    console.log('No knowledge yet.');

    return;
  }

  entries.forEach((entry) => {
    console.log(`${entry.id}  [${entry.kind}]  ${entry.statement}`);

    if (entry.copy !== undefined) {
      console.log(
        `      use "${entry.copy.use}"${
          entry.copy.never.length === 0
            ? ''
            : ` — never ${entry.copy.never
                .map((term) => `"${term}"`)
                .join(', ')}`
        } (${entry.copy.meaning})`
      );
    }

    console.log(`      why: ${entry.why}`);
  });
};

/**
 * Copy this machine's new entries into the checked-in store, so they ship
 * with the next commit. Add-only.
 */
export const runKnowledgeSync = (): void => {
  const { local, shared } = knowledgeDirs();
  const { added, skipped } = syncKnowledge(local, shared);

  console.log(
    added.length === 0
      ? 'Knowledge: nothing new to share.'
      : `Knowledge: added ${added.length} new judgement/copy ${
          added.length === 1 ? 'entry' : 'entries'
        } to ${shared}.`
  );
  skipped.forEach(({ entry, reason }) =>
    console.log(
      `Knowledge: skipped "${entry.statement.slice(0, 60)}" — ${reason}.`
    )
  );
};
