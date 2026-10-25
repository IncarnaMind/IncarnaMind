/**
 * By DOI or arXiv number: Crossref, OpenAlex, then arXiv for a preprint,
 * until a record is the work as cited, else the closest. Otherwise Crossref's
 * matching of the reference as written, then OpenAlex by its title when
 * Crossref's record is missing or differs. A service that can't be asked
 * leaves the reference unchecked rather than reading as a mismatch.
 */
import type { ReferenceCheck, ReferenceCheckReason, ReferenceService } from "../api";
import { ConsentRevokedError, LocalModeError } from "../errors";
import { SourceError } from "../sources/http";
import type { Lookups } from "./lookups";
import {
  type CitedReference,
  differences,
  holdsTitle,
  titleCoverage,
  titleOf,
  type WorkRecord,
} from "./match";

export class ServiceFailure extends Error {
  override name = "ServiceFailure";
  constructor(
    readonly service: ReferenceService,
    readonly reason: ReferenceCheckReason,
    /** When a service that asked to slow down takes requests again, epoch milliseconds. */
    readonly resetsAt: number | null = null,
    cause?: unknown,
  ) {
    super(`${service}: ${reason}`, { cause });
  }
}

/** One check of a list: the services, and those it stopped asking (offline, or asked to slow down). */
export interface CheckRun {
  readonly lookups: Lookups;
  readonly stopped: Map<ReferenceService, ServiceFailure>;
}

const reasonOf = (error: unknown): ReferenceCheckReason =>
  error instanceof SourceError &&
  (error.reason === "rate-limited" || error.reason === "unreachable")
    ? error.reason
    : "service-error";

/** Offline, or asked to slow down, a service isn't asked again for the rest of the list. */
async function ask<T>(
  run: CheckRun,
  service: ReferenceService,
  signal: AbortSignal,
  call: () => Promise<T>,
): Promise<T> {
  const stopped = run.stopped.get(service);
  if (stopped) throw stopped;
  try {
    return await call();
  } catch (error) {
    // Stopped before sending: no service failed.
    if (signal.aborted || error instanceof LocalModeError || error instanceof ConsentRevokedError) {
      throw error;
    }
    const reason = reasonOf(error);
    const resetsAt = error instanceof SourceError ? error.resetsAt : null;
    const failure = new ServiceFailure(service, reason, resetsAt, error);
    if (reason !== "service-error") run.stopped.set(service, failure);
    throw failure;
  }
}

function shown(record: WorkRecord): NonNullable<ReferenceCheck["record"]> {
  const { fields } = record;
  return {
    title: fields.title ?? "",
    authors: fields.authors ?? [],
    year: record.years.length > 0 ? Math.min(...record.years) : null,
    doi: fields.doi || null,
  };
}

function compared(
  cited: CitedReference,
  record: WorkRecord,
  service: ReferenceService,
): ReferenceCheck {
  const found = differences(cited, record);
  return {
    reference: cited.text,
    mark: found.length === 0 ? "found" : "mismatch",
    service,
    record: shown(record),
    differences: found,
    reason: null,
  };
}

/** Among a reprint and a later edition, the record that differs least; `sameAuthor` for a search by title alone. */
function bestOf(
  cited: CitedReference,
  records: readonly WorkRecord[],
  service: ReferenceService,
  sameAuthor: boolean,
): ReferenceCheck | null {
  let best: { check: ReferenceCheck; coverage: number } | null = null;
  for (const record of records) {
    const title = record.fields.title ?? "";
    if (!holdsTitle(cited.text, title)) continue;
    const check = compared(cited, record, service);
    if (sameAuthor && check.differences.some((each) => each.field === "authors")) continue;
    const coverage = titleCoverage(cited.text, title);
    const fewer = best ? best.check.differences.length - check.differences.length : 1;
    if (fewer > 0 || (fewer === 0 && best && coverage > best.coverage)) best = { check, coverage };
  }
  return best?.check ?? null;
}

/** Of several checks of a reference, the one that differs least; the first on a tie. */
const fewestDifferences = (checks: readonly ReferenceCheck[]): ReferenceCheck | null =>
  checks.reduce<ReferenceCheck | null>(
    (best, check) => (!best || check.differences.length < best.differences.length ? check : best),
    null,
  );

/** Checks one reference; throws `ServiceFailure` when a service it needs can't be asked. */
export async function checkReference(
  cited: CitedReference,
  run: CheckRun,
  signal: AbortSignal,
): Promise<ReferenceCheck> {
  const { crossref, openalex, arxiv } = run.lookups;
  const unmatched = (
    mark: ReferenceCheck["mark"],
    service: ReferenceService | null,
  ): ReferenceCheck => ({
    reference: cited.text,
    mark,
    service,
    record: null,
    differences: [],
    reason: null,
  });

  // arXiv's own DOI, which DataCite registers for every preprint, so Crossref holds none.
  const doi = cited.doi ?? (cited.arxiv ? `10.48550/arXiv.${cited.arxiv}` : null);
  if (doi) {
    const checks: ReferenceCheck[] = [];
    const lookUp = async (
      service: ReferenceService,
      call: () => Promise<WorkRecord | null>,
    ): Promise<ReferenceCheck | null> => {
      const record = await ask(run, service, signal, call);
      if (!record) return null;
      const check = compared(cited, record, service);
      checks.push(check);
      return check.mark === "found" ? check : null;
    };
    const found = cited.doi && (await lookUp("crossref", () => crossref.byDoi(doi, signal)));
    if (found) return found;
    if (checks.length === 0) {
      // Crossref says which agency registered a DOI, any agency's: none, and it leads nowhere.
      const agency = await ask(run, "crossref", signal, () => crossref.agency(doi, signal));
      if (agency === null) return unmatched("not-found", "crossref");
    }
    const { arxiv: id } = cited;
    // A preprint is still looked for on arXiv while OpenAlex can't be asked; the outage stands otherwise.
    let openAlexDown: ServiceFailure | null = null;
    try {
      const inOpenAlex = await lookUp("openalex", () => openalex.byDoi(doi, signal));
      if (inOpenAlex) return inOpenAlex;
    } catch (error) {
      if (!(id && error instanceof ServiceFailure)) throw error;
      openAlexDown = error;
    }
    // Asked only about a number that exists: arXiv's API can hang on one that doesn't.
    const onArxiv = id && (await lookUp("arxiv", () => arxiv.byId(id, signal)));
    if (onArxiv) return onArxiv;
    if (openAlexDown) throw openAlexDown;
    return (
      fewestDifferences(checks) ?? {
        ...unmatched("not-checked", null),
        reason: "registered-elsewhere",
      }
    );
  }

  const inCrossref = bestOf(
    cited,
    await ask(run, "crossref", signal, () => crossref.search(cited.text, signal)),
    "crossref",
    false,
  );
  if (inCrossref?.mark === "found") return inCrossref;
  // Crossref's record may be another edition's (a reprint, a later year): OpenAlex may hold the one cited.
  const title = titleOf(cited.text) ?? cited.text;
  const searched = await ask(run, "openalex", signal, () => openalex.search(title, signal));
  const inOpenAlex = bestOf(cited, searched, "openalex", true);
  if (
    inCrossref &&
    (!inOpenAlex || inOpenAlex.differences.length >= inCrossref.differences.length)
  ) {
    return inCrossref;
  }
  return inOpenAlex ?? unmatched("not-listed", null);
}
