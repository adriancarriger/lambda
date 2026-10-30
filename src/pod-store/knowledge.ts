import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/**
 * Long-term knowledge: the owner's lasting product JUDGEMENTS ("a closed trail
 * stays on the map, greyed out") and COPY rules ("write the trail's name in
 * full on every marker"). Planning checks every new plan against them.
 *
 * Stored ONE FILE PER ENTRY, named by a hash of its normalized wording, in two
 * places: this machine's `<podsRoot>/_knowledge/` (gitignored, written
 * instantly) and the checked-in `.lambda/knowledge/` (shared by every
 * machine). `syncKnowledge` copies new local entries into the checked-in
 * folder at commit time — so two
 * machines adding different entries touch different files (no merge
 * conflict), and the same entry is the same file with the same content.
 *
 * ADD-ONLY: nothing is ever edited or deleted. Changing or retiring one is a
 * new entry that `supersedes` it. Duplicates are caught by code, never a
 * model: an exact match is the same hash; a near-duplicate is one sharing
 * ≥ NEAR_DUPLICATE of its words.
 */

export const KNOWLEDGE_KINDS = ['judgement', 'copy'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KnowledgeEntrySchema = z.object({
  /** Hash of kind + normalized statement — also the file name. */
  id: z.string().regex(/^[a-f0-9]{12}$/),
  kind: z.enum(KNOWLEDGE_KINDS),
  /** The judgement or rule, in one plain sentence that stands alone. */
  statement: z.string().min(1),
  /** Why it's good long term. */
  why: z.string().min(1),
  /** The owner's own words it came from, when it came from the owner. */
  quote: z.string().optional(),
  /** Copy rules: the term to use, the ones never to use, what it means. */
  copy: z
    .object({
      use: z.string().min(1),
      never: z.array(z.string()),
      meaning: z.string().min(1),
    })
    .optional(),
  /** Where it was decided (a pod, a ticket). */
  source: z.string().optional(),
  /** Earlier entries this one replaces (they stop counting). */
  supersedes: z.array(z.string()).optional(),
  createdAt: z.string(),
});

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/** Words shared above this fraction = a near-duplicate (skipped, reported). */
export const NEAR_DUPLICATE = 0.85;

export const normalizeStatement = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[^a-z0-9\u00c0-\u024f\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const knowledgeId = (kind: KnowledgeKind, statement: string): string =>
  createHash('sha256')
    .update(`${kind}\n${normalizeStatement(statement)}`)
    .digest('hex')
    .slice(0, 12);

const words = (text: string): Set<string> =>
  new Set(
    normalizeStatement(text)
      .split(' ')
      .filter((word) => word !== '')
  );

/** Jaccard overlap of the two statements' words, 0…1. */
export const statementSimilarity = (a: string, b: string): number => {
  const left = words(a);
  const right = words(b);
  const shared = Array.from(left).filter((word) => right.has(word)).length;
  const union = new Set(Array.from(left).concat(Array.from(right))).size;

  return union === 0 ? 1 : shared / union;
};

const kindDir = (root: string, kind: KnowledgeKind): string =>
  path.join(root, kind === 'judgement' ? 'judgements' : 'copy');

/** Every entry in a knowledge folder (both kinds). Unreadable files are skipped. */
export const readKnowledge = (root: string): KnowledgeEntry[] =>
  KNOWLEDGE_KINDS.flatMap((kind) => {
    const dir = kindDir(root, kind);

    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try {
          return [
            KnowledgeEntrySchema.parse(
              JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
            ),
          ];
        } catch {
          return [];
        }
      });
  });

/** Union by id (the same entry in both places counts once), oldest first. */
export const mergeKnowledge = (
  ...sources: KnowledgeEntry[][]
): KnowledgeEntry[] =>
  Array.from(
    new Map(sources.flat().map((entry) => [entry.id, entry] as const)).values()
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** What still counts: everything not superseded by a later entry. */
export const activeKnowledge = (
  entries: KnowledgeEntry[]
): KnowledgeEntry[] => {
  const superseded = new Set(
    entries.flatMap((entry) => entry.supersedes ?? [])
  );

  return entries.filter((entry) => !superseded.has(entry.id));
};

export type AddResult =
  | { status: 'added'; entry: KnowledgeEntry }
  | { status: 'exists'; entry: KnowledgeEntry }
  | { status: 'near-duplicate'; entry: KnowledgeEntry; of: KnowledgeEntry }
  | { status: 'conflict'; entry: KnowledgeEntry; of: KnowledgeEntry };

const term = (text: string): string => normalizeStatement(text);

/**
 * Copy rules that contradict: one says use a term the other says never to
 * use ("say signpost" vs "never signpost"). Caught by code — word
 * overlap alone misses it.
 */
const contradicts = (a: KnowledgeEntry, b: KnowledgeEntry): boolean => {
  if (a.copy === undefined || b.copy === undefined) {
    return false;
  }

  const bannedByB = b.copy.never.map(term);
  const bannedByA = a.copy.never.map(term);

  return (
    bannedByB.includes(term(a.copy.use)) || bannedByA.includes(term(b.copy.use))
  );
};

/**
 * Check a new entry against what's known (exact hash, then near-duplicate of
 * an active entry of the same kind). An entry that supersedes another is
 * allowed to be close to it — that's the point of a rewording.
 */
export const classifyNew = (
  entry: KnowledgeEntry,
  known: KnowledgeEntry[]
): AddResult => {
  const exact = known.find((candidate) => candidate.id === entry.id);

  if (exact !== undefined) {
    return { status: 'exists', entry: exact };
  }

  const near = activeKnowledge(known).find(
    (candidate) =>
      candidate.kind === entry.kind &&
      !(entry.supersedes ?? []).includes(candidate.id) &&
      statementSimilarity(candidate.statement, entry.statement) >=
        NEAR_DUPLICATE
  );

  if (near !== undefined) {
    return { status: 'near-duplicate', entry, of: near };
  }

  const conflict = activeKnowledge(known).find(
    (candidate) =>
      candidate.kind === 'copy' &&
      entry.kind === 'copy' &&
      !(entry.supersedes ?? []).includes(candidate.id) &&
      contradicts(entry, candidate)
  );

  return conflict === undefined
    ? { status: 'added', entry }
    : { status: 'conflict', entry, of: conflict };
};

/** Write an entry's file, never overwriting one that exists. */
export const writeKnowledgeFile = (
  root: string,
  entry: KnowledgeEntry
): boolean => {
  const dir = kindDir(root, entry.kind);
  const file = path.join(dir, `${entry.id}.json`);

  if (fs.existsSync(file)) {
    return false;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(KnowledgeEntrySchema.parse(entry), null, 2)}\n`,
    { flag: 'wx' }
  );

  return true;
};

/** Build an entry (id from the wording) — callers then classify and write it. */
export const makeKnowledgeEntry = (
  input: Omit<KnowledgeEntry, 'id' | 'createdAt'> & { createdAt?: string }
): KnowledgeEntry => ({
  ...input,
  id: knowledgeId(input.kind, input.statement),
  createdAt: input.createdAt ?? new Date().toISOString(),
});

/**
 * Copy this machine's new entries into the shared (checked-in) folder:
 * ADD-ONLY — never edits or deletes a file there — skipping exact duplicates
 * (same file already present) and near-duplicates of shared entries.
 */
export const syncKnowledge = (
  localRoot: string,
  sharedRoot: string
): {
  added: KnowledgeEntry[];
  skipped: { entry: KnowledgeEntry; reason: string }[];
} => {
  const local = readKnowledge(localRoot);
  const shared = readKnowledge(sharedRoot);

  return local.reduce<{
    added: KnowledgeEntry[];
    skipped: { entry: KnowledgeEntry; reason: string }[];
    known: KnowledgeEntry[];
  }>(
    (acc, entry) => {
      const verdict = classifyNew(entry, acc.known);

      if (verdict.status === 'exists') {
        return acc;
      }

      if (
        verdict.status === 'near-duplicate' ||
        verdict.status === 'conflict'
      ) {
        return {
          ...acc,
          skipped: [
            ...acc.skipped,
            {
              entry,
              reason: `${
                verdict.status === 'conflict'
                  ? 'contradicts'
                  : 'near-duplicate of'
              } ${verdict.of.id} ("${verdict.of.statement.slice(0, 60)}")`,
            },
          ],
        };
      }

      writeKnowledgeFile(sharedRoot, entry);

      return {
        ...acc,
        added: [...acc.added, entry],
        known: [...acc.known, entry],
      };
    },
    { added: [], skipped: [], known: shared }
  );
};
