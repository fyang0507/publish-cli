import test from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import {
  sameLinkedInReopenedDraftText,
  saveAsDraftLinkedIn,
  type SaveAsDraftLinkedInDependencies,
} from "./draftPoster.js";
import {
  LinkedInDraftStageError,
  snapshotLinkedInDraftStageError,
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
  });
  assert.equal(snapshotLinkedInDraftStageError({
    savePhase: "save_not_attempted",
    saveMechanism: "composer_close_save",
    message: RAW_CANARY,
  }), null);
});
