import test from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import {
  dismissPreviewCard,
  sameLinkedInReopenedDraftText,
  startEmptyComposer,
  verifyDraftSaved,
  type ReopenDraftDependencies,
  type StartEmptyComposerDependencies,
} from "./composer.js";
import {
  saveAsDraftLinkedIn,
  setComposerMedia,
  type LinkedInMediaSetDependencies,
  type SaveAsDraftLinkedInDependencies,
} from "./draftPoster.js";
import { LI_COMPOSER_SELECTORS } from "./selectors.js";
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

test("reopen matching accepts LinkedIn's lnkd.in short link in place of an intended link, and nothing else (#137)", () => {
  const expected = "Draft test — will be deleted https://example.com/path?q=1&x=2\nSee (https://example.com/b).";
  assert.equal(
    sameLinkedInReopenedDraftText(
      "Draft test — will be deleted https://lnkd.in/gxaXtz5D\nSee (https://lnkd.in/D_e-f9).",
      expected,
    ),
    true,
  );
  assert.equal(
    sameLinkedInReopenedDraftText(
      "Draft test — will be deleted https://example.com/path?q=1&x=2\nSee (https://lnkd.in/D_e-f9).",
      expected,
    ),
    true,
    "LinkedIn may leave some links unshortened",
  );
  for (const actual of [
    "Draft test — will be deleted https://lnkd.in/gxaXtz5D\nSee (https://lnkd.in/D_e-f9)",
    "Draft test — will be deleted https://lnkd.in/gxaXtz5D extra\nSee (https://lnkd.in/D_e-f9).",
    "Draft test — will be deleted https://other.example/x\nSee (https://lnkd.in/D_e-f9).",
    "Draft test — will be deleted https://lnkd.in/\nSee (https://lnkd.in/D_e-f9).",
    "Draft test — will be deleted\nSee (https://lnkd.in/D_e-f9).",
  ]) {
    assert.equal(sameLinkedInReopenedDraftText(actual, expected), false, actual);
  }
  assert.equal(sameLinkedInReopenedDraftText("Old draft https://lnkd.in/abc", "No link here"), false);
  assert.equal(sameLinkedInReopenedDraftText("a.b https://lnkd.in/x", "a*b https://example.com"), false);
});

function composerDeps(
  restoredSequence: boolean[],
  events: string[],
  options: { closeMissing?: boolean; discardMissing?: boolean } = {},
): StartEmptyComposerDependencies {
  let opens = 0;
  const editor = { id: "editor" } as unknown as Locator;
  return {
    async open() { opens += 1; events.push(`open:${opens}`); return editor; },
    async restored() { const value = restoredSequence.shift() ?? false; events.push(`restored:${value}`); return value; },
    async locateClose() {
      events.push("close:locate");
      return options.closeMissing ? null : { async click() { events.push("close:click"); } } as unknown as Locator;
    },
    async locateDiscard() {
      events.push("discard:locate");
      return options.discardMissing ? null : { async click() { events.push("discard:click"); } } as unknown as Locator;
    },
    async wait(_page, milliseconds) { events.push(`wait:${milliseconds}`); },
  };
}

test("a restored draft is discarded through its own confirmation before typing; an empty composer is left alone (#137)", async () => {
  assert.match(LI_COMPOSER_SELECTORS.closeComposerButton[0], /^dialog\[data-testid="dialog"\] > /);
  assert.equal(LI_COMPOSER_SELECTORS.mediaButton[0], 'dialog[data-testid="dialog"] button[aria-label="Media"]');
  assert.equal(LI_COMPOSER_SELECTORS.discardDraftButton, '//button[normalize-space()="Discard"]');

  const empty: string[] = [];
  await startEmptyComposer({} as Page, () => empty.push("modified"), composerDeps([false], empty));
  assert.deepEqual(empty, ["open:1", "restored:false"]);

  const restored: string[] = [];
  await startEmptyComposer({} as Page, () => restored.push("modified"), composerDeps([true, false], restored));
  assert.deepEqual(restored, [
    "open:1", "restored:true", "close:locate", "close:click", "discard:locate",
    "modified", "discard:click", "open:2", "restored:false", "wait:10000",
  ]);

  for (const options of [{ closeMissing: true }, { discardMissing: true }]) {
    const events: string[] = [];
    await assert.rejects(() => startEmptyComposer({} as Page, () => events.push("modified"), composerDeps([true], events, options)));
    assert.equal(events.includes("discard:click"), false);
    assert.equal(events.includes("modified"), false);
  }

  // The discarded draft may still be restored for a moment: reopen until empty.
  const lagging: string[] = [];
  await startEmptyComposer({} as Page, () => lagging.push("modified"), composerDeps([true, true, true, false], lagging));
  assert.deepEqual(lagging.slice(6), [
    "discard:click", "open:2", "restored:true", "wait:1000", "open:3", "restored:true",
    "wait:1000", "open:4", "restored:false", "wait:10000",
  ]);

  const stuck: string[] = [];
  await assert.rejects(
    () => startEmptyComposer({} as Page, () => stuck.push("modified"), composerDeps([true, true, true, true, true, true], stuck)),
    /still holds a draft/,
  );
  assert.ok(stuck.includes("modified"));
  assert.equal(stuck.filter((event) => event.startsWith("open:")).length, 6);
  assert.equal(stuck.filter((event) => event === "discard:click").length, 1);
});

function previewCardPage(cards: number, events: string[], lookupError?: Error): Page {
  let remaining = cards;
  const locator = {
    filter() { return locator; },
    first() {
      return { async waitFor() {
        if (lookupError) throw lookupError;
        if (remaining === 0) {
          const timeout = new Error(RAW_CANARY);
          timeout.name = "TimeoutError";
          throw timeout;
        }
      } };
    },
    async count() { return remaining; },
    async click() { events.push("card:dismiss"); remaining = 0; },
    async waitFor(options: { state: string }) { events.push(`card:${options.state}`); },
  };
  return { locator(selector: string) {
    events.push(`locate:${selector}`);
    return locator;
  } } as unknown as Page;
}

test("with media requested, the new text's link-preview card is dismissed so the Photo control returns (#137)", async () => {
  const none: string[] = [];
  await dismissPreviewCard(previewCardPage(0, none));
  assert.deepEqual(none, [`locate:${LI_COMPOSER_SELECTORS.previewCard} button[aria-label="Dismiss"]`]);

  const one: string[] = [];
  await dismissPreviewCard(previewCardPage(1, one));
  assert.deepEqual(one.slice(1), ["card:dismiss", "card:detached"]);

  const two: string[] = [];
  await assert.rejects(() => dismissPreviewCard(previewCardPage(2, two)), /ambiguous/);
  assert.equal(two.includes("card:dismiss"), false);

  await assert.rejects(() => dismissPreviewCard(previewCardPage(1, [], new Error("Target closed"))), /Target closed/);
});

function reopenDeps(texts: Array<string | null>, events: string[]): ReopenDraftDependencies {
  let clock = 0;
  let current = "";
  return {
    async reopen() {
      const next = texts.shift();
      events.push(`reopen:${next === null ? "none" : JSON.stringify(next)}`);
      if (next === null || next === undefined) return null;
      current = next;
      return { async innerText() { return current; } } as unknown as Locator;
    },
    async wait(_page, milliseconds) { clock += milliseconds; },
    now: () => clock,
  };
}

test("verification reopens a composer that stays empty, and stops at restored text that doesn't match (#137)", async () => {
  const expected = "Draft test https://example.com/x";

  const late: string[] = [];
  assert.equal(await verifyDraftSaved({} as Page, expected, reopenDeps(["\n", "", "Draft test https://lnkd.in/abc"], late)), true);
  assert.equal(late.length, 3);

  const other: string[] = [];
  assert.equal(await verifyDraftSaved({} as Page, expected, reopenDeps(["Older draft", expected], other)), false);
  assert.deepEqual(other, ['reopen:"Older draft"']);

  const never: string[] = [];
  assert.equal(await verifyDraftSaved({} as Page, expected, reopenDeps(["", "", "", "", "", expected], never)), false);
  assert.equal(never.length, 5);

  assert.equal(await verifyDraftSaved({} as Page, expected, reopenDeps([null], [])), false);
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
