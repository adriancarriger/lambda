import { z } from 'zod';

/**
 * The setup endpoints' bodies. The page sends only choices, a folder path, a
 * name, a key and a pasted code: never command text. A body that fails its
 * schema is answered 400 with zod's first issue, and nothing runs.
 */

export const ClaudeStartBody = z.object({}).strict();

export const ClaudeCodeBody = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      // Each character goes to the pty as a keystroke.
      .regex(/^[\x21-\x7e]+$/, 'That code has spaces or line breaks in it.'),
  })
  .strict();

export const ProjectBody = z
  .object({
    /** A folder the person picked (either picker). */
    folder: z.string().min(1).max(4096).optional(),
    /** "Start something new": `~/Lambda/<name>`. */
    name: z.string().max(255).optional(),
  })
  .strict()
  .refine((body) => (body.folder === undefined) !== (body.name === undefined), {
    message: 'Send a folder or a name.',
  });

/** A pasted key: printable ASCII with no space or line break inside it. */
const Key = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[\x21-\x7e]+$/, 'That key has spaces or line breaks in it.');

export const TicketsBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('markdown') }).strict(),
  z
    .object({
      source: z.literal('linear'),
      apiKey: Key,
    })
    .strict(),
  z
    .object({
      source: z.literal('jira'),
      site: z.string().trim().min(1).max(500),
      email: z.string().trim().min(1).max(320),
      apiToken: Key,
    })
    .strict(),
]);

export type TicketsBodyType = z.infer<typeof TicketsBody>;

/** "That login is me": an email or a name, counted as the owner's. */
export const YouBody = z
  .object({ login: z.string().trim().min(1).max(320) })
  .strict();
