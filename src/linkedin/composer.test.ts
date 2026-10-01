import test from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import {
  dismissPreviewCard,
  locateRestoredDraftDiscard,
  sameLinkedInReopenedDraftText,
  startEmptyComposer,
  verifyDraftSaved,
  type ReopenDraftDependencies,
  type StartEmptyComposerDependencies,
} from "./composer.js";
import { LI_COMPOSER_SELECTORS } from "./selectors.js";

const RAW_CANARY = "selector=[data-secret] PRIVATE_PATH_CANARY cookie=li-secret";

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
  // CJK text right after a link is not part of it, and must still match.
  assert.equal(
    sameLinkedInReopenedDraftText("原文https://lnkd.in/abc\n下一段", "原文https://a.com/x，这里是一大段中文。\n下一段"),
    false,
  );
  assert.equal(
    sameLinkedInReopenedDraftText("原文https://lnkd.in/abc，这里。\n「https://lnkd.in/x9」", "原文https://a.com/x，这里。\n「HTTPS://A.com/Y」"),
    true,
  );
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
    "modified", "discard:click", "wait:10000", "open:2", "restored:false",
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
    "discard:click", "wait:10000", "open:2", "restored:true", "wait:1000", "open:3", "restored:true",
    "wait:1000", "open:4", "restored:false",
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

test("with media requested, the new text's link-preview card is dismissed so the Media control returns (#137)", async () => {
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

function discardDialogPage(discards: number, saves: number): Page {
  return { locator(selector: string) {
    const count = selector.startsWith("xpath=") ? discards : saves;
    const locator = {
      filter() { return locator; },
      first() { return { async waitFor() {
        if (count === 0) { const timeout = new Error(RAW_CANARY); timeout.name = "TimeoutError"; throw timeout; }
      } }; },
      async count() { return count; },
    };
    return locator;
  } } as unknown as Page;
}

test("the Discard guard needs exactly one Discard and one Save as draft (#137)", async () => {
  assert.ok(await locateRestoredDraftDiscard(discardDialogPage(1, 1)));
  for (const [discards, saves] of [[0, 1], [2, 1], [1, 0], [1, 2]]) {
    assert.equal(await locateRestoredDraftDiscard(discardDialogPage(discards, saves)), null, `${discards}/${saves}`);
  }
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
