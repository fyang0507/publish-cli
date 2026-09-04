import type { StageDraftResult } from "./draftPoster.js";
import {
  isXDraftReturnedSavePhase,
  isXDraftRowEvidenceCompatible,
  snapshotXDraftRowEvidence,
  type XDraftRowEvidence,
  type XDraftRowObservation,
} from "./saveProgress.js";
import {
  X_NON_ARTICLE_ARRAY_ENTRIES_MAX,
  X_NON_ARTICLE_ADVISORY_CODE_UNITS_MAX,
  createXGeneratedContentSnapshotContext,
  failXGeneratedContentSnapshot,
  snapshotXBoundedString,
  snapshotXPlainRecord,
  type XGeneratedContentSnapshotContext,
} from "./nonArticleStageSnapshot.js";

const OBSERVATION_KEYS = [
  "outcome",
  "route",
  "modal",
  "rows",
  "visibleModalCount",
  "visibleRowCount",
  "exactFullTextMatches",
] as const;

const EVIDENCE_KEYS = [
  "status",
  "method",
  "contentMatch",
  "nativeRowId",
  "listCompleteness",
  "baseline",
  "postSave",
] as const;

function snapshotObservation(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): Readonly<Record<(typeof OBSERVATION_KEYS)[number], unknown>> {
  return snapshotXPlainRecord(
    value,
    OBSERVATION_KEYS,
    [],
    context,
    (reader) => Object.freeze({
      outcome: reader.read("outcome"),
      route: reader.read("route"),
      modal: reader.read("modal"),
      rows: reader.read("rows"),
      visibleModalCount: reader.read("visibleModalCount"),
      visibleRowCount: reader.read("visibleRowCount"),
      exactFullTextMatches: reader.read("exactFullTextMatches"),
    }),
  );
}

function freezeEvidence(evidence: XDraftRowEvidence): XDraftRowEvidence {
  if (evidence.baseline === null || evidence.postSave === null) {
    return Object.freeze({ ...evidence });
  }
  return Object.freeze({
    ...evidence,
    baseline: Object.freeze({ ...evidence.baseline }) as XDraftRowObservation,
    postSave: Object.freeze({ ...evidence.postSave }) as XDraftRowObservation,
  }) as XDraftRowEvidence;
}

function snapshotEvidence(
  value: unknown,
  context: XGeneratedContentSnapshotContext,
): XDraftRowEvidence {
  const copied = snapshotXPlainRecord(
    value,
    EVIDENCE_KEYS,
    [],
    context,
    (reader) => {
      const baseline = reader.read("baseline");
      const postSave = reader.read("postSave");
      return Object.freeze({
        status: reader.read("status"),
        method: reader.read("method"),
        contentMatch: reader.read("contentMatch"),
        nativeRowId: reader.read("nativeRowId"),
        listCompleteness: reader.read("listCompleteness"),
        baseline: baseline === null ? null : snapshotObservation(baseline, context),
        postSave: postSave === null ? null : snapshotObservation(postSave, context),
      });
    },
  );
  const normalized = snapshotXDraftRowEvidence(copied);
  if (normalized === null) failXGeneratedContentSnapshot();
  return freezeEvidence(normalized);
}

/**
 * Close the resolved composer result as data. Unlike the stage-promise
 * rejection boundary, no malformed returned value can carry Save phase.
 */
export function snapshotXNonArticleStageResult(
  value: unknown,
  expectedFormat: "tweet" | "thread",
  expectedPosts: number,
): StageDraftResult | null {
  const context = createXGeneratedContentSnapshotContext();
  try {
    return snapshotXPlainRecord(
      value,
      [
        "format",
        "posts",
        "note",
        "saveMechanism",
        "savePhase",
        "draftRowEvidence",
      ],
      [],
      context,
      (reader) => {
        const format = reader.read("format");
        const posts = reader.read("posts");
        const note = snapshotXBoundedString(
          reader.read("note"),
          X_NON_ARTICLE_ADVISORY_CODE_UNITS_MAX,
          context,
        );
        const saveMechanism = reader.read("saveMechanism");
        const savePhase = reader.read("savePhase");
        const draftRowEvidence = snapshotEvidence(
          reader.read("draftRowEvidence"),
          context,
        );
        if (
          format !== expectedFormat ||
          !Number.isSafeInteger(posts) ||
          (posts as number) <= 0 ||
          (posts as number) > X_NON_ARTICLE_ARRAY_ENTRIES_MAX ||
          posts !== expectedPosts ||
          saveMechanism !== "composer_close_save" ||
          !isXDraftReturnedSavePhase(savePhase) ||
          !isXDraftRowEvidenceCompatible(
            saveMechanism,
            savePhase,
            draftRowEvidence,
          )
        ) {
          failXGeneratedContentSnapshot();
        }
        return Object.freeze({
          format,
          posts,
          note,
          saveMechanism,
          savePhase,
          draftRowEvidence,
        }) as StageDraftResult;
      },
    );
  } catch {
    return null;
  }
}
