import {
  type ColdRead,
  ColdReadSchema,
  OptionSchema,
  type Question,
  type QuestionSection,
  RecommendationSchema,
  VisualSchema,
} from './schemas';

/**
 * Why a draft may not be committed. An empty list means it may.
 *
 * The rules are the quality gate in front of the owner's inbox:
 * every section present, 2–4 options, a recommendation that names a real
 * option, a cold read that found nothing missing, and no open question this
 * one depends on (asking behind an unanswered hinge is how questions go stale).
 */
export const commitProblems = (
  question: Question,
  coldRead: ColdRead | undefined,
  justification: string,
  siblings: Question[]
): string[] => {
  const missingSections = (['summary', 'context', 'problem'] as const).filter(
    (section) => (question[section] ?? '').trim() === ''
  );

  const optionIds = question.options.map((option) => option.id);

  const { recommendation } = question;

  const openDependencies = question.dependsOn.filter((dependency) =>
    siblings.some(
      (sibling) => sibling.id === dependency && sibling.status === 'open'
    )
  );

  const unknownDependencies = question.dependsOn.filter(
    (dependency) => !siblings.some((sibling) => sibling.id === dependency)
  );

  return [
    ...(question.status === 'draft'
      ? []
      : [
          `Question ${question.id} is ${question.status}; only drafts can be committed.`,
        ]),
    ...missingSections.map((section) => `Missing section: ${section}.`),
    ...(question.options.length < 2 || question.options.length > 4
      ? [`Needs 2–4 options; has ${question.options.length}.`]
      : []),
    ...(new Set(optionIds).size === optionIds.length
      ? []
      : ['Option ids must be unique.']),
    ...(recommendation === undefined
      ? ['Missing section: recommendation.']
      : []),
    ...(recommendation !== undefined &&
    !optionIds.includes(recommendation.optionId)
      ? [
          `Recommendation points at option "${recommendation.optionId}", which does not exist.`,
        ]
      : []),
    ...(recommendation !== undefined && recommendation.why.trim() === ''
      ? ['Recommendation needs a "why".']
      : []),
    ...(justification.trim() === ''
      ? ['A justification for why this question is ready is required.']
      : []),
    ...(coldRead === undefined ? ['A cold-read result is required.'] : []),
    ...(coldRead !== undefined && coldRead.missing.length > 0
      ? [
          `The cold read still needed to ask: ${coldRead.missing.join(
            ' | '
          )}. Revise the question so a reader without context could decide.`,
        ]
      : []),
    ...openDependencies.map(
      (dependency) =>
        `Depends on ${dependency}, which is still open. Ask the hinging question alone first; queue this one after it is answered.`
    ),
    ...unknownDependencies.map(
      (dependency) => `Unknown dependency ${dependency}.`
    ),
  ];
};

export const parseColdRead = (raw: unknown): ColdRead =>
  ColdReadSchema.parse(raw);

/**
 * Apply one section edit to a draft. `options` takes a JSON array of
 * {id,label,detail,tradeoffs}; `recommendation` takes JSON {optionId,why};
 * `visual` takes JSON {ascii,notes,spoken}; the rest take plain text.
 */
export const applySectionEdit = (
  question: Question,
  section: QuestionSection,
  value: string
): Question => {
  if (question.status !== 'draft') {
    throw new Error(
      `Question ${question.id} is ${question.status}; only drafts can be edited. Withdraw it and add a new one.`
    );
  }

  if (section === 'options') {
    return {
      ...question,
      options: OptionSchema.array().parse(JSON.parse(value)),
    };
  }

  if (section === 'recommendation') {
    return {
      ...question,
      recommendation: RecommendationSchema.parse(JSON.parse(value)),
    };
  }

  if (section === 'visual') {
    return { ...question, visual: VisualSchema.parse(JSON.parse(value)) };
  }

  return { ...question, [section]: value };
};
