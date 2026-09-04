import test from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import {
  sameLinkedInReopenedDraftText,
  saveAsDraftLinkedIn,
  setComposerMedia,
  type LinkedInMediaSetDependencies,
  type SaveAsDraftLinkedInDependencies,
} from "./draftPoster.js";
import {
  createLinkedInMediaStageEvidence,
  LinkedInDraftStageError,
  snapshotLinkedInDraftStageError,
  snapshotLinkedInDraftStageResult,
} from "./saveProgress.js";

const RAW_CANARY =
  "selector=[data-secret] PRIVATE_PATH_CANARY/operator/session cookie=li-secret page=Private LinkedIn composer";

async function capturedStageError(run: () => Promise<unknown>): Promise<LinkedInDraftStageError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof LinkedInDraftStageError);
    assert.doesNotMatch(error.message, /data-secret|PRIVATE_PATH_CANARY|li-secret|Private LinkedIn/);
    return error;
  }
  assert.fail("Expected LinkedInDraftStageError");
}

interface SaveFixture {
  closeMissing?: boolean;
  closeFails?: boolean;
  saveMissing?: boolean;
  saveLookupFails?: boolean;
  saveFailsAfterSideEffect?: boolean;
  settleFails?: boolean;
}

function saveDependencies(
  fixture: SaveFixture,
  events: string[],
): SaveAsDraftLinkedInDependencies {
  const close = {
    async click() {
      events.push("close:click");
      if (fixture.closeFails) throw new Error(RAW_CANARY);
    },
  } as unknown as Locator;
  const save = {
    async click() {
      events.push("save:click:side-effect");
      if (fixture.saveFailsAfterSideEffect) throw new Error(RAW_CANARY);
    },
  } as unknown as Locator;
  return {
    async locateClose() {
      events.push("close:locate");
      return fixture.closeMissing ? null : close;
    },
    async locateSave() {
      events.push("save:locate");
      if (fixture.saveLookupFails) throw new Error(RAW_CANARY);
      return fixture.saveMissing ? null : save;
    },
    async settle() {
      events.push("save:settle");
      if (fixture.settleFails) throw new Error(RAW_CANARY);
    },
  };
}

test("LinkedIn stops before Save and never reopens when the pre-save path fails", async () => {
  for (const fixture of [
    { closeMissing: true },
    { closeFails: true },
    { saveMissing: true },
    { saveLookupFails: true },
  ] as const) {
    const events: string[] = [];
    const error = await capturedStageError(() => saveAsDraftLinkedIn(
      {} as Page,
      async () => {
        events.push("reopen:verify");
        return true;
      },
      saveDependencies(fixture, events),
    ));
    assert.equal(error.savePhase, "save_not_attempted");
    assert.equal(events.includes("save:click:side-effect"), false);
    assert.equal(events.includes("reopen:verify"), false);
    assert.equal(events.some((event) => /post|publish|send/i.test(event)), false);
  }
});

test("a Save click side effect followed by rejection is delivery unknown", async () => {
  const events: string[] = [];
  const error = await capturedStageError(() => saveAsDraftLinkedIn(
    {} as Page,
    async () => {
      events.push("reopen:verify");
      return true;
    },
    saveDependencies({ saveFailsAfterSideEffect: true }, events),
  ));
  assert.equal(error.savePhase, "save_delivery_unknown");
  assert.deepEqual(events, [
    "close:locate",
    "close:click",
    "save:locate",
    "save:click:side-effect",
  ]);
});

test("settle rejection and reopening rejection are delivered but unverified", async () => {
  const settleEvents: string[] = [];
  const settleError = await capturedStageError(() => saveAsDraftLinkedIn(
    {} as Page,
    async () => true,
    saveDependencies({ settleFails: true }, settleEvents),
  ));
  assert.equal(settleError.savePhase, "save_delivered_unverified");
  assert.equal(settleEvents.filter((event) => event === "save:click:side-effect").length, 1);

  const reopenEvents: string[] = [];
  const reopenError = await capturedStageError(() => saveAsDraftLinkedIn(
    {} as Page,
    async () => {
      reopenEvents.push("reopen:verify");
      throw new Error(RAW_CANARY);
    },
    saveDependencies({}, reopenEvents),
  ));
  assert.equal(reopenError.savePhase, "save_delivered_unverified");
  assert.equal(reopenEvents.filter((event) => event === "save:click:side-effect").length, 1);
  assert.equal(reopenEvents.filter((event) => event === "reopen:verify").length, 1);
});

test("negative reopen remains unverified and only positive reopen verifies", async () => {
  for (const verified of [false, true]) {
    const events: string[] = [];
    const result = await saveAsDraftLinkedIn(
      {} as Page,
      async () => {
        events.push("reopen:verify");
        return verified;
      },
      saveDependencies({}, events),
    );
    assert.equal(result.savePhase, verified ? "verified" : "save_delivered_unverified");
    assert.deepEqual(events, [
      "close:locate",
      "close:click",
      "save:locate",
      "save:click:side-effect",
      "save:settle",
      "reopen:verify",
    ]);
  }
});

test("reopen matching requires the complete intended text", () => {
  const expected = "Shared first forty characters 1234567890\nExact intended ending";
  assert.equal(sameLinkedInReopenedDraftText(expected, expected), true);
  assert.equal(
    sameLinkedInReopenedDraftText(
      "Shared first forty characters 1234567890\nDifferent old draft ending",
      expected,
    ),
    false,
  );
  assert.equal(sameLinkedInReopenedDraftText(expected.toUpperCase(), expected), false);
  assert.equal(sameLinkedInReopenedDraftText(expected.replace("\n", "  "), expected), false);
  assert.equal(sameLinkedInReopenedDraftText("Cafe\u0301\r\nBody", "Café\nBody"), true);
});

test("only branded LinkedIn stage errors carry phase evidence", () => {
  const genuine = new LinkedInDraftStageError("save_delivery_unknown");
  assert.deepEqual(snapshotLinkedInDraftStageError(genuine), {
    savePhase: "save_delivery_unknown",
    saveMechanism: "composer_close_save",
    platformTouched: true,
    composerModified: true,
    media: [],
  });
  assert.equal(snapshotLinkedInDraftStageError({
    savePhase: "save_not_attempted",
    saveMechanism: "composer_close_save",
    message: RAW_CANARY,
  }), null);
});

test("LinkedIn stage snapshots retain ordered set-only media evidence", () => {
  const media = createLinkedInMediaStageEvidence(2, true);
  const result = snapshotLinkedInDraftStageResult({
    format: "post",
    saveMechanism: "composer_close_save",
    savePhase: "verified",
    verified: true,
    platformTouched: true,
    composerModified: true,
    media,
  }, 2);
  assert.deepEqual(result?.media, [
    { index: 0, requested: true, resolved: true, set: true, observed: null, verified: null },
    { index: 1, requested: true, resolved: true, set: true, observed: null, verified: null },
  ]);
  assert.equal(Object.isFrozen(result?.media), true);
  assert.equal(Object.isFrozen(result?.media[0]), true);

  assert.equal(snapshotLinkedInDraftStageResult({
    format: "post",
    saveMechanism: "composer_close_save",
    savePhase: "verified",
    verified: true,
    platformTouched: true,
    composerModified: true,
    media: [{ ...media[0], observed: true }],
  }, 1), null, "file-setting must not manufacture UI observation");

  assert.equal(snapshotLinkedInDraftStageResult({
    format: "post",
    saveMechanism: "composer_close_save",
    savePhase: "verified",
    verified: true,
    platformTouched: false,
    composerModified: false,
    media: createLinkedInMediaStageEvidence(1, true),
  }, 1), null, "set media requires a touched and modified composer");
});

test("typed failures preserve composer and media progress without raw details", () => {
  const error = new LinkedInDraftStageError("save_not_attempted", {
    platformTouched: true,
    composerModified: true,
    media: createLinkedInMediaStageEvidence(2, null),
  });
  Object.defineProperty(error, "cause", { value: new Error(RAW_CANARY) });
  assert.deepEqual(snapshotLinkedInDraftStageError(error, 2), {
    savePhase: "save_not_attempted",
    saveMechanism: "composer_close_save",
    platformTouched: true,
    composerModified: true,
    media: [
      { index: 0, requested: true, resolved: true, set: null, observed: null, verified: null },
      { index: 1, requested: true, resolved: true, set: null, observed: null, verified: null },
    ],
  });
});

test("a rejected chooser set call is never retried through the hidden input", async () => {
  const events: string[] = [];
  const states: Array<boolean | null> = [];
  const deps: LinkedInMediaSetDependencies = {
    async acquireChooser() {
      events.push("chooser:acquired");
      return {
        async setFiles() {
          events.push("chooser:set:possibly-effective");
          throw new Error(RAW_CANARY);
        },
      };
    },
    async resolveFileInput() {
      events.push("hidden:resolved");
      return {
        async setInputFiles() {
          events.push("hidden:set");
        },
      };
    },
    async finishSelection() {
      events.push("selection:finished");
    },
  };
  const completed = await setComposerMedia(
    {} as Page,
    ["/safe/a.png"],
    (state) => states.push(state),
    deps,
  );
  assert.equal(completed, false);
  assert.deepEqual(states, [null]);
  assert.deepEqual(events, ["chooser:acquired", "chooser:set:possibly-effective"]);
});

test("hidden input fallback runs only when no chooser setting was invoked", async () => {
  const events: string[] = [];
  const states: Array<boolean | null> = [];
  const deps: LinkedInMediaSetDependencies = {
    async acquireChooser() {
      events.push("chooser:unavailable");
      return null;
    },
    async resolveFileInput() {
      events.push("hidden:resolved");
      return {
        async setInputFiles() {
          events.push("hidden:set");
        },
      };
    },
    async finishSelection() {
      events.push("selection:finished");
    },
  };
  const completed = await setComposerMedia(
    {} as Page,
    ["/safe/a.png"],
    (state) => states.push(state),
    deps,
  );
  assert.equal(completed, true);
  assert.deepEqual(states, [null, true]);
  assert.deepEqual(events, [
    "chooser:unavailable",
    "hidden:resolved",
    "hidden:set",
    "selection:finished",
  ]);
});
