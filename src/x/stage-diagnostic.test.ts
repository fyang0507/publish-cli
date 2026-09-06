import test from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { executeXDraftRealRun, receiptForXDraftOutcome } from "../commands/draft.js";
import { generateContent } from "./content.js";
import { saveAsDraft, uniqueComposerLocator, type SaveAsDraftDependencies } from "./draftPoster.js";
import { runXDraftSaveFlow, snapshotXDraftStageError, XDraftStageError } from "./saveProgress.js";
import {
  snapshotXDraftDiagnostic,
  XDraftOperationError,
  X_DRAFT_SUBSTAGES,
  xDraftOperationDiagnostic,
} from "./stageDiagnostic.js";

const CANARY = "PRIVATE_PATH_CANARY cookie=secret selector=[private] unrelated page content";
const page = {} as Page;

test("the final receipt does not invoke diagnostic accessors or proxy traps", async () => {
  const content = await generateContent("A bounded draft.", { format: "tweet" });
  const outcome = await executeXDraftRealRun({ content }, {
    loadStageDraft: async () => async () => {
      throw new XDraftStageError("save_not_attempted", "composer_close_save", {
        substage: "save_control", reason: "control_missing",
      });
    },
  });
  let reads = 0;
  Object.defineProperty(outcome, "diagnostic", {
    get() { reads += 1; throw new Error(CANARY); },
  });
  const receipt = receiptForXDraftOutcome(outcome, "tweet");
  assert.equal(reads, 0);
  assert.equal(receipt.exit.code, 1);
  assert.equal(receipt.error?.stage, "save_not_attempted");
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_PATH_CANARY|substage=/);

  const proxy = new Proxy(outcome, {
    get() { reads += 1; throw new Error(CANARY); },
    getOwnPropertyDescriptor() { reads += 1; throw new Error(CANARY); },
  });
  assert.throws(() => receiptForXDraftOutcome(proxy, "tweet"), {
    message: "The X draft outcome cannot be inspected safely.",
  });
  assert.equal(reads, 0);
});

test("concrete pre-Save failures reach bounded actionable receipts without any Save invocation", async () => {
  for (const fixture of [
    { stage: "close_control", reason: "control_missing" },
    { stage: "close_control", reason: "control_ambiguous" },
    { stage: "close_composer", reason: "operation_rejected" },
    { stage: "save_control", reason: "control_missing" },
    { stage: "save_control", reason: "control_ambiguous" },
    { stage: "save_control", reason: "operation_rejected" },
  ] as const) {
    let saveCalls = 0;
    let verificationCalls = 0;
    const close = { async click() {
      if (fixture.stage === "close_composer") throw new Error(CANARY);
    } } as Locator;
    const save = { async click() { saveCalls += 1; } } as unknown as Locator;
    const deps: SaveAsDraftDependencies = {
      async locateClose() {
        if (fixture.stage === "close_control") {
          if (fixture.reason === "control_missing") return null;
          throw new XDraftOperationError(fixture.stage, fixture.reason);
        }
        return close;
      },
      async locateSave() {
        if (fixture.stage === "save_control") {
          if (fixture.reason === "control_missing") return null;
          if (fixture.reason === "operation_rejected") throw new Error(CANARY);
          throw new XDraftOperationError(fixture.stage, fixture.reason);
        }
        return save;
      },
      async settle() {},
    };
    const content = await generateContent("A bounded draft.", { format: "tweet" });
    const outcome = await executeXDraftRealRun({ content }, {
      loadStageDraft: async () => async () => {
        await saveAsDraft(page, async () => { verificationCalls += 1; throw new Error(CANARY); }, deps);
        throw new Error("Unexpected Save completion");
      },
    });
    const receipt = receiptForXDraftOutcome(outcome, "tweet");
    assert.equal(saveCalls, 0);
    assert.equal(verificationCalls, 0);
    assert.equal(receipt.exit.code, 1);
    assert.equal(receipt.error?.stage, "save_not_attempted");
    assert.equal(receipt.error?.code, "x_save_not_attempted");
    assert.match(receipt.error!.sanitizedMessage, new RegExp(`substage=${fixture.stage}; reason=${fixture.reason}`));
    assert.match(receipt.error!.suggestedCorrection!, /exact CLI-owned profile/);
    assert.match(receipt.error!.suggestedCorrection!, /Reconcile|reconcile/);
    assert.equal(receipt.terminalState, "no_native_draft");
    assert.equal(receipt.remoteResidue[0]?.state, "composer_residue_unknown");
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_PATH_CANARY|cookie=secret|\[private\]|unrelated page/);
  }
});

test("Save rejection and post-Save verification failure retain their own diagnostic and never retry", async () => {
  for (const failure of ["save_delivery", "draft_verification"] as const) {
    let saveCalls = 0;
    const deps: SaveAsDraftDependencies = {
      locateClose: async () => ({ click: async () => {} }) as unknown as Locator,
      locateSave: async () => ({ click: async () => {
        saveCalls += 1;
        if (failure === "save_delivery") throw new Error(CANARY);
      } }) as unknown as Locator,
      settle: async () => {},
    };
    const content = await generateContent("A bounded draft.", { format: "tweet" });
    const outcome = await executeXDraftRealRun({ content }, {
      loadStageDraft: async () => async () => {
        await saveAsDraft(page, async () => { throw new Error(CANARY); }, deps);
        throw new Error("Unexpected Save completion");
      },
    });
    const receipt = receiptForXDraftOutcome(outcome, "tweet");
    assert.equal(saveCalls, 1);
    assert.equal(receipt.error?.stage, failure === "save_delivery"
      ? "save_delivery_unknown" : "save_delivered_unverified");
    assert.match(receipt.error!.sanitizedMessage, new RegExp(`substage=${failure}; reason=operation_rejected`));
    assert.match(receipt.error!.suggestedCorrection!, /before deciding whether a separate retry is safe/);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_PATH_CANARY|cookie=secret|no Save was attempted/);
  }
});

function locatorPage(visibility: readonly boolean[], rejectLookup = false): Page {
  return { locator() {
    const elements = visibility.map((visible) => ({ visible }));
    const make = (items: typeof elements): unknown => ({
      filter() { return make(items.filter((item) => item.visible)); },
      first() { return { async waitFor() {
        if (rejectLookup) throw new Error(CANARY);
        if (items.length === 0) {
          const error = new Error(CANARY);
          error.name = "TimeoutError";
          throw error;
        }
      } }; },
      async count() { return items.length; },
      nth(index: number) { return { async isVisible() { return items[index].visible; } }; },
    });
    return make(elements);
  } } as unknown as Page;
}

test("composer control lookup distinguishes missing, ambiguous and rejected observation; hidden duplicates do not select the wrong control", async () => {
  for (const fixture of [
    { visibility: [], reason: "control_missing", reject: false },
    { visibility: [true, true], reason: "control_ambiguous", reject: false },
    { visibility: [true], reason: "operation_rejected", reject: true },
  ]) {
    await assert.rejects(
      () => uniqueComposerLocator(locatorPage(fixture.visibility, fixture.reject), ["[calibrated]"], "save_control"),
      (error: unknown) => {
        assert.deepEqual(xDraftOperationDiagnostic(error), { substage: "save_control", reason: fixture.reason });
        assert.doesNotMatch(String(error), /PRIVATE_PATH_CANARY|cookie=secret/);
        return true;
      },
    );
  }
  assert.ok(await uniqueComposerLocator(locatorPage([false, true]), ["[calibrated]"], "save_control"));
});

test("diagnostic evidence rejects hostile fields and contradictions with the independently proven Save phase", async () => {
  let reads = 0;
  const hostile = Object.defineProperty({ reason: "control_missing" }, "substage", {
    get() { reads += 1; throw new Error(CANARY); },
  });
  assert.equal(snapshotXDraftDiagnostic(hostile), null);
  assert.equal(reads, 0);
  assert.equal(snapshotXDraftDiagnostic(new Proxy({}, { ownKeys() { throw new Error(CANARY); } })), null);
  assert.equal(snapshotXDraftDiagnostic({ substage: CANARY, reason: CANARY }), null);
  assert.ok(Object.isFrozen(X_DRAFT_SUBSTAGES));
  assert.throws(() => (X_DRAFT_SUBSTAGES as unknown as string[]).push(CANARY), TypeError);
  assert.equal(snapshotXDraftDiagnostic({ substage: CANARY, reason: "operation_rejected" }), null);
  assert.equal(snapshotXDraftDiagnostic({ substage: "save_delivery", reason: "control_missing" }), null);

  for (const boundary of ["deliverSave", "afterSave"] as const) {
    await assert.rejects(() => runXDraftSaveFlow("composer_close_save", {
      beforeSave: async () => {},
      deliverSave: async () => {
        if (boundary === "deliverSave") throw new XDraftOperationError("close_control", "control_missing");
      },
      afterSave: async () => { throw new XDraftStageError("save_not_attempted", "composer_close_save", {
        substage: "close_control", reason: "control_missing",
      }); },
    }), (error: unknown) => {
      const snapshot = snapshotXDraftStageError(error);
      assert.equal(snapshot?.savePhase, boundary === "deliverSave" ? "save_delivery_unknown" : "save_delivered_unverified");
      assert.equal(snapshot?.diagnostic, null);
      return true;
    });
  }
  const contradictory = new XDraftStageError("save_delivery_unknown", "composer_close_save");
  Object.defineProperty(contradictory, "diagnostic", { value: { substage: "close_control", reason: "control_missing" } });
  assert.equal(snapshotXDraftStageError(contradictory)?.diagnostic, null);
  Object.defineProperty(contradictory, "diagnostic", { get() { reads += 1; throw new Error(CANARY); } });
  assert.equal(snapshotXDraftStageError(contradictory)?.diagnostic, null);
  assert.equal(reads, 0);
});
