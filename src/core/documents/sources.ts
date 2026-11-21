/**
 * Which Documents count as sources (#3492): every live Document but the copy of a file an outside
 * agent handed over to be checked (#3412) while it is Not cited, as it is from its first version,
 * and a file from outside the Library an agent cited by its path (#3509), which is evidence only
 * for the sentences that cite it. What an AI made is never searched, read, quoted or cited as a
 * source, by the assistant, a check or an agent, until the User cites it again, which makes it one
 * of their own Documents. The User's own workings are Not cited too, but they are still read to
 * understand a Question.
 *
 * SQL true of the Document whose `documents` row is `row` (a table name or an alias).
 */
export const isSource = (row: string): string =>
  `(${row}.cited_by IS NULL AND NOT (${row}.not_cited = 1 AND EXISTS (
     SELECT 1 FROM agent_files f WHERE f.document_id = ${row}.id AND f.deleted_at IS NULL)))`;
