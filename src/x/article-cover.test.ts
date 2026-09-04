import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ElementHandle, Page } from "playwright";
import { LocalValidationError } from "../capabilities/validation.js";
import {
  preloadXArticleCover,
  xArticleCoverFilePayload,
} from "./articleCover.js";
import {
  X_COMPOSER_SELECTORS,
  isCalibratedXArticleCoverCrop,
  isCalibratedXArticleCoverTarget,
  sameArticleCoverObservation,
  stageArticleCover,
  waitForCalibratedArticleCoverObservation,
  type ArticleCoverStageDependencies,
  type XArticleCoverObservationResult,
  type XArticleCoverTargetFacts,
} from "./draftPoster.js";

const VALID_TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAIAAAAfCIEKAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkQAUsaHwAAIAABtETi70AAAAASUVORK5CYII=",
  "base64",
);

function pngContainerWithDimensions(width: number, height: number): Buffer {
  const value = Buffer.from(VALID_TINY_PNG);
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function webp(width: number, height: number): Buffer {
  const value = Buffer.alloc(30);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(value.length - 8, 4);
  value.write("WEBP", 8, "ascii");
  value.write("VP8 ", 12, "ascii");
  value.writeUInt32LE(10, 16);
  value[23] = 0x9d;
  value[24] = 0x01;
  value[25] = 0x2a;
  value.writeUInt16LE(width, 26);
  value.writeUInt16LE(height, 28);
  return value;
}

function assertCoverFailure(
  action: () => unknown,
  code: string,
  secretPathFragment?: string,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LocalValidationError);
    assert.equal(error.problem.code, code);
    if (secretPathFragment) {
      assert.doesNotMatch(error.message, new RegExp(secretPathFragment, "u"));
      assert.doesNotMatch(JSON.stringify(error.problem), new RegExp(secretPathFragment, "u"));
    }
    return true;
  });
}

test("X Article cover preloads one valid PNG, JPEG, and WebP as detached exact-5:2 bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-article-cover-valid-"));
  try {
    const fixtures = [
      ["cover.png", VALID_TINY_PNG, "image/png", 5, 2],
      ["cover.jpg", jpeg(1500, 600), "image/jpeg", 1500, 600],
      ["cover.webp", webp(1500, 600), "image/webp", 1500, 600],
    ] as const;
    for (const [name, bytes, contentType, width, height] of fixtures) {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      const cover = preloadXArticleCover(path);
      assert.equal(Object.isFrozen(cover), true);
      assert.equal(cover.selection, "explicit");
      assert.equal(cover.contentType, contentType);
      assert.equal(cover.width, width);
      assert.equal(cover.height, height);
      assert.equal(cover.ratio, "exact_5_2");
      assert.equal(cover.sizeBytes, bytes.length);
      assert.match(cover.sourceSha256, /^[a-f0-9]{64}$/u);
      assert.equal(JSON.stringify(cover).includes(dir), false);
      assert.equal(JSON.stringify(cover).includes(path), false);
      assert.deepEqual(xArticleCoverFilePayload(cover)?.buffer, bytes);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cover preload rejects representative filesystem, header, dimension, type, suffix, ratio, and representation failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-secret-path-"));
  try {
    const invalid = join(dir, "operator-private-invalid.png");
    const dimensionless = join(dir, "dimensionless.jpg");
    const unsupported = join(dir, "unsupported.gif");
    const spoofed = join(dir, "spoofed.png");
    const wrongRatio = join(dir, "wrong-ratio.webp");
    const tooWide = join(dir, "too-wide.png");
    const nonFile = join(dir, "directory.png");
    writeFileSync(invalid, "not an image");
    writeFileSync(dimensionless, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(1500, 6);
    gif.writeUInt16LE(600, 8);
    writeFileSync(unsupported, gif);
    writeFileSync(spoofed, jpeg(1500, 600));
    writeFileSync(wrongRatio, webp(1500, 601));
    writeFileSync(tooWide, pngContainerWithDimensions(250_000_000, 100_000_000));
    mkdirSync(nonFile);

    assertCoverFailure(
      () => preloadXArticleCover(join(dir, "operator-private-missing.png")),
      "x_article_cover_not_found",
      "operator-private",
    );
    assertCoverFailure(() => preloadXArticleCover(nonFile), "x_article_cover_not_regular_file");
    assertCoverFailure(() => preloadXArticleCover(invalid), "x_article_cover_header_invalid");
    assertCoverFailure(() => preloadXArticleCover(dimensionless), "x_article_cover_dimensions_unreadable");
    assertCoverFailure(() => preloadXArticleCover(unsupported), "x_article_cover_type_unsupported");
    assertCoverFailure(() => preloadXArticleCover(spoofed), "x_article_cover_extension_mismatch");
    assertCoverFailure(() => preloadXArticleCover(wrongRatio), "x_article_cover_ratio_invalid");
    assertCoverFailure(
      () => preloadXArticleCover(tooWide),
      "x_article_cover_dimensions_out_of_range",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cover preload rejects malformed or truncated PNG and WebP containers", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-container-"));
  try {
    const truncatedPng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(truncatedPng);
    truncatedPng.write("IHDR", 12, "ascii");
    truncatedPng.writeUInt32BE(5, 16);
    truncatedPng.writeUInt32BE(2, 20);

    const malformedIhdr = Buffer.from(VALID_TINY_PNG);
    malformedIhdr.writeUInt32BE(12, 8);

    const badRiffSize = webp(5, 2);
    badRiffSize.writeUInt32LE(0, 4);

    const oversizedWebpChunk = webp(5, 2);
    oversizedWebpChunk.writeUInt32LE(20, 16);

    const fixtures = [
      ["truncated.png", truncatedPng],
      ["malformed-ihdr.png", malformedIhdr],
      ["truncated-iend.png", VALID_TINY_PNG.subarray(0, VALID_TINY_PNG.length - 1)],
      ["bad-riff-size.webp", badRiffSize],
      ["oversized-chunk.webp", oversizedWebpChunk],
    ] as const;

    for (const [name, bytes] of fixtures) {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      assertCoverFailure(() => preloadXArticleCover(path), "x_article_cover_container_invalid");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cover payload remains the exact validated byte copy after source replacement and removal", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-snapshot-"));
  try {
    const path = join(dir, "cover.png");
    const original = Buffer.from(VALID_TINY_PNG);
    writeFileSync(path, original);
    const cover = preloadXArticleCover(path);
    const replacement = Buffer.from(VALID_TINY_PNG);
    replacement[replacement.length - 13] ^= 0xff;
    writeFileSync(path, replacement);
    rmSync(path);

    const payload = xArticleCoverFilePayload(cover);
    assert.ok(payload);
    assert.deepEqual(payload.buffer, original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const EDIT_URL = "https://x.com/compose/articles/edit/12345";

const OBSERVED_COVER = Object.freeze({
  sourceIdentitySha256: "a".repeat(64),
  box: Object.freeze({ x: 100, y: 120, width: 1_000, height: 400 }),
  naturalWidth: 5,
  naturalHeight: 2,
});

function coverStageDeps(overrides: Partial<ArticleCoverStageDependencies> = {}) {
  const calls: string[] = [];
  const input = {
    async setInputFiles() {
      calls.push("input-set-returned");
    },
  } as unknown as ElementHandle<HTMLInputElement>;
  const apply = {
    async click() {
      calls.push("apply-returned");
    },
  } as unknown as ElementHandle<HTMLElement>;
  const dialogCounts = [0, 0];
  const observations: XArticleCoverObservationResult[] = [
    Object.freeze({ status: "none" }),
    Object.freeze({ status: "observed", observation: OBSERVED_COVER }),
  ];
  const deps: ArticleCoverStageDependencies = {
    async resolveTarget() {
      calls.push("resolve-target");
      return Object.freeze({ input, editUrl: EDIT_URL });
    },
    async targetStillCalibrated() {
      calls.push("target-still-calibrated");
      return true;
    },
    async activeDialogCount() {
      calls.push("active-dialog-count");
      return dialogCounts.shift() ?? 0;
    },
    async locateApply(_page, editUrl, expectedWidth, expectedHeight) {
      calls.push("locate-apply");
      assert.equal(editUrl, EDIT_URL);
      assert.equal(expectedWidth, 5);
      assert.equal(expectedHeight, 2);
      return apply;
    },
    async settleAfterSet() {
      calls.push("settle-set");
    },
    async settleAfterApply() {
      calls.push("settle-apply");
    },
    async observeCover(_page, editUrl, expectedWidth, expectedHeight) {
      calls.push("observe-cover");
      assert.equal(editUrl, EDIT_URL);
      assert.equal(expectedWidth, 5);
      assert.equal(expectedHeight, 2);
      return observations.shift() ?? Object.freeze({ status: "invalid" });
    },
    ...overrides,
  };
  return { deps, calls, input, apply };
}

test("production cover selectors match only the live-calibrated editor contract", () => {
  assert.equal(
    X_COMPOSER_SELECTORS.articleTitleInput,
    'textarea[placeholder="Add a title"]',
  );
  assert.equal(
    X_COMPOSER_SELECTORS.articleBodyInput,
    'div[data-testid="composer"][contenteditable="true"]',
  );
  assert.equal(
    X_COMPOSER_SELECTORS.articleMediaButton,
    'button[aria-label="Add photos or video"]',
  );
  assert.equal(
    X_COMPOSER_SELECTORS.articleMediaFileInput,
    'input[type="file"][data-testid="fileInput"][accept="image/jpeg,image/png,image/webp"]',
  );
  assert.equal(
    X_COMPOSER_SELECTORS.articleCoverDialog,
    'div[role="dialog"][aria-modal="true"]',
  );
  assert.equal(X_COMPOSER_SELECTORS.articleCoverApply, '[data-testid="applyButton"]');
  assert.equal(
    X_COMPOSER_SELECTORS.articleCoverPreview,
    'img[src^="https://pbs.twimg.com/media/"]',
  );
  assert.equal("articleCoverButton" in X_COMPOSER_SELECTORS, false);
  assert.equal("articleCoverFileInput" in X_COMPOSER_SELECTORS, false);
  assert.doesNotMatch(
    JSON.stringify({
      title: X_COMPOSER_SELECTORS.articleTitleInput,
      mediaButton: X_COMPOSER_SELECTORS.articleMediaButton,
      mediaInput: X_COMPOSER_SELECTORS.articleMediaFileInput,
      apply: X_COMPOSER_SELECTORS.articleCoverApply,
    }),
    /twitter-article-title|longform|Add cover|ancestor::|text\(\)/u,
  );
});

const VALID_TARGET_FACTS: Readonly<XArticleCoverTargetFacts> = Object.freeze({
  visibleEnabledTitleCount: 1,
  visibleBodyCount: 1,
  visibleEnabledMediaButtonCount: 1,
  exactFileInputCount: 1,
  rootMediaButtonCount: 1,
  rootFileInputCount: 1,
  rootIsEditor: true,
  sameImmediateParent: true,
  inputEnabled: true,
  inputMultiple: false,
  buttonStrictlyAboveTitle: true,
});

test("cover target classifier accepts only the unique editor-root sibling above-title shape", () => {
  assert.equal(isCalibratedXArticleCoverTarget(VALID_TARGET_FACTS), true);

  const invalidCases: Array<readonly [string, Partial<XArticleCoverTargetFacts>]> = [
    ["duplicate title", { visibleEnabledTitleCount: 2 }],
    ["sidebar title instead of editor textarea", { visibleEnabledTitleCount: 0 }],
    ["duplicate body", { visibleBodyCount: 2 }],
    ["duplicate in-root media buttons", {
      visibleEnabledMediaButtonCount: 2,
      rootMediaButtonCount: 2,
    }],
    ["duplicate in-root file inputs", {
      exactFileInputCount: 2,
      rootFileInputCount: 2,
    }],
    ["global competing file input", { exactFileInputCount: 2 }],
    ["media control outside editor root", { rootMediaButtonCount: 0 }],
    ["file input outside editor root", { rootFileInputCount: 0 }],
    ["page-level common root", { rootIsEditor: false }],
    ["broken immediate sibling relation", { sameImmediateParent: false }],
    ["disabled file input", { inputEnabled: false }],
    ["multiple-file input", { inputMultiple: true }],
    ["button below title", { buttonStrictlyAboveTitle: false }],
  ];
  for (const [name, changes] of invalidCases) {
    assert.equal(
      isCalibratedXArticleCoverTarget({ ...VALID_TARGET_FACTS, ...changes }),
      false,
      name,
    );
  }
});

test("reopen parity requires the same sanitized source, natural dimensions, and box", () => {
  assert.equal(sameArticleCoverObservation(OBSERVED_COVER, OBSERVED_COVER), true);
  assert.equal(
    sameArticleCoverObservation(OBSERVED_COVER, {
      ...OBSERVED_COVER,
      sourceIdentitySha256: "b".repeat(64),
    }),
    false,
  );
  assert.equal(
    sameArticleCoverObservation(OBSERVED_COVER, {
      ...OBSERVED_COVER,
      naturalWidth: OBSERVED_COVER.naturalWidth + 1,
    }),
    false,
  );
  assert.equal(
    sameArticleCoverObservation(OBSERVED_COVER, {
      ...OBSERVED_COVER,
      box: { ...OBSERVED_COVER.box, width: OBSERVED_COVER.box.width + 1 },
    }),
    false,
  );
});

test("calibrated cover observation polling accepts a delayed positive sample", async () => {
  let observationCalls = 0;
  const waits: number[] = [];
  const page = {
    url() { return EDIT_URL; },
    async waitForTimeout(milliseconds: number) { waits.push(milliseconds); },
  } as unknown as Page;

  const result = await waitForCalibratedArticleCoverObservation(
    page,
    EDIT_URL,
    5,
    2,
    async (_page, editUrl, expectedWidth, expectedHeight) => {
      observationCalls += 1;
      assert.equal(editUrl, EDIT_URL);
      assert.equal(expectedWidth, 5);
      assert.equal(expectedHeight, 2);
      return observationCalls === 3
        ? Object.freeze({ status: "observed", observation: OBSERVED_COVER })
        : Object.freeze({ status: "none" });
    },
  );

  assert.deepEqual(result, { status: "observed", observation: OBSERVED_COVER });
  assert.equal(observationCalls, 3);
  assert.deepEqual(waits, [250, 250]);
});

test("calibrated cover observation polling caps persistent invalid or ambiguous evidence", async () => {
  let observationCalls = 0;
  const waits: number[] = [];
  const page = {
    url() { return EDIT_URL; },
    async waitForTimeout(milliseconds: number) { waits.push(milliseconds); },
  } as unknown as Page;

  const result = await waitForCalibratedArticleCoverObservation(
    page,
    EDIT_URL,
    5,
    2,
    async (): Promise<XArticleCoverObservationResult> => {
      observationCalls += 1;
      // The calibrated observer closes duplicate/ambiguous DOM evidence as invalid.
      return Object.freeze({ status: "invalid" });
    },
  );

  assert.deepEqual(result, { status: "invalid" });
  assert.equal(observationCalls, 33);
  assert.equal(waits.length, 32);
  assert.ok(waits.every((milliseconds) => milliseconds === 250));
});

test("cover staging sets the calibrated input once and records the full Apply chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-stage-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);
    const fixture = coverStageDeps();
    const handoff = await stageArticleCover({} as Page, cover, fixture.deps);
    assert.equal(handoff.set, true);
    assert.equal(handoff.setPhase, "set_returned");
    assert.equal(handoff.applyPhase, "returned");
    assert.equal(handoff.observed, true);
    assert.equal(handoff.verified, null);
    assert.deepEqual(fixture.calls, [
      "resolve-target",
      "active-dialog-count",
      "observe-cover",
      "target-still-calibrated",
      "input-set-returned",
      "settle-set",
      "locate-apply",
      "apply-returned",
      "settle-apply",
      "active-dialog-count",
      "observe-cover",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-set settle and observation rejections preserve one-shot cover progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-post-set-rejection-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);

    const settleFailure = coverStageDeps({
      async settleAfterSet() { throw new Error("post-set settle rejected"); },
    });
    const unsettled = await stageArticleCover(
      {} as Page,
      cover,
      settleFailure.deps,
    );
    assert.equal(unsettled.set, true);
    assert.equal(unsettled.setPhase, "set_returned");
    assert.equal(unsettled.applyPhase, "not_observed");
    assert.equal(unsettled.observed, false);
    assert.equal(unsettled.verified, null);
    assert.equal(
      settleFailure.calls.filter((call) => call === "input-set-returned").length,
      1,
    );
    assert.equal(settleFailure.calls.includes("locate-apply"), false);
    assert.equal(settleFailure.calls.includes("apply-returned"), false);

    let observationCalls = 0;
    const observationFailure = coverStageDeps({
      async observeCover() {
        observationCalls += 1;
        if (observationCalls === 1) return Object.freeze({ status: "none" as const });
        throw new Error("post-Apply observation rejected");
      },
    });
    const unobserved = await stageArticleCover(
      {} as Page,
      cover,
      observationFailure.deps,
    );
    assert.equal(unobserved.set, true);
    assert.equal(unobserved.setPhase, "set_returned");
    assert.equal(unobserved.applyPhase, "returned");
    assert.equal(unobserved.observed, false);
    assert.equal(unobserved.verified, null);
    assert.equal(observationCalls, 2);
    assert.equal(
      observationFailure.calls.filter((call) => call === "input-set-returned").length,
      1,
    );
    assert.equal(
      observationFailure.calls.filter((call) => call === "apply-returned").length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected exact input set is delivery-unknown and never retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-set-unknown-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);
    let setCalls = 0;
    const fixture = coverStageDeps({
      async resolveTarget() {
        return Object.freeze({
          editUrl: EDIT_URL,
          input: {
            async setInputFiles() {
              setCalls += 1;
              throw new Error("possibly effective rejection");
            },
          } as unknown as ElementHandle<HTMLInputElement>,
        });
      },
      async settleAfterSet() { assert.fail("set did not return"); },
      async locateApply() { assert.fail("Apply was not reached"); },
      async settleAfterApply() { assert.fail("Apply was not reached"); },
    });
    const handoff = await stageArticleCover({} as Page, cover, fixture.deps);
    assert.equal(handoff.set, null);
    assert.equal(handoff.setPhase, "set_delivery_unknown");
    assert.equal(handoff.applyPhase, "not_reached");
    assert.equal(handoff.observed, false);
    assert.equal(handoff.verified, null);
    assert.equal(setCalls, 1);
    assert.equal(fixture.calls.includes("locate-apply"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unavailable or no-longer-calibrated target performs no upload attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-control-missing-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);
    for (const failure of ["unavailable", "recalibration failed"] as const) {
      let setCalls = 0;
      const fixture = coverStageDeps({
        async resolveTarget() {
          if (failure === "unavailable") return null;
          return Object.freeze({
            editUrl: EDIT_URL,
            input: {
              async setInputFiles() { setCalls += 1; },
            } as unknown as ElementHandle<HTMLInputElement>,
          });
        },
        async targetStillCalibrated() {
          return failure !== "recalibration failed";
        },
      });
      const handoff = await stageArticleCover({} as Page, cover, fixture.deps);
      assert.equal(handoff.set, false, failure);
      assert.equal(handoff.setPhase, "target_unavailable", failure);
      assert.equal(handoff.applyPhase, "not_reached", failure);
      assert.equal(handoff.observed, false, failure);
      assert.equal(setCalls, 0, failure);
      assert.equal(fixture.calls.includes("locate-apply"), false, failure);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing, ambiguous, or dimension-mismatched crop evidence means no Apply click", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-apply-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);
    assert.equal(isCalibratedXArticleCoverCrop(1, cover.width, cover.height, 5, 2), true);
    assert.equal(isCalibratedXArticleCoverCrop(0, null, null, 5, 2), false);
    assert.equal(isCalibratedXArticleCoverCrop(2, cover.width, cover.height, 5, 2), false);
    assert.equal(isCalibratedXArticleCoverCrop(1, cover.width + 1, cover.height, 5, 2), false);
    assert.equal(isCalibratedXArticleCoverCrop(1, cover.width, cover.height + 1, 5, 2), false);
    for (const condition of [
      "missing crop image",
      "two visible crop images",
      "crop natural dimensions differ from the preloaded bytes",
    ] as const) {
      let locateCalls = 0;
      const fixture = coverStageDeps({
        async locateApply(_page, editUrl, expectedWidth, expectedHeight) {
          locateCalls += 1;
          assert.equal(editUrl, EDIT_URL, condition);
          assert.equal(expectedWidth, cover.width, condition);
          assert.equal(expectedHeight, cover.height, condition);
          return null;
        },
      });
      const handoff = await stageArticleCover({} as Page, cover, fixture.deps);
      assert.equal(handoff.set, true, condition);
      assert.equal(handoff.applyPhase, "not_observed", condition);
      assert.equal(handoff.observed, false, condition);
      assert.equal(handoff.verified, null, condition);
      assert.equal(locateCalls, 1, condition);
      assert.equal(fixture.calls.includes("apply-returned"), false, condition);
      assert.equal(
        fixture.calls.filter((call) => call === "observe-cover").length,
        1,
        condition,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-Apply evidence must be observed and match the preloaded natural dimensions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-post-apply-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);
    const cases: Array<readonly [string, XArticleCoverObservationResult]> = [
      [
        "wrong natural dimensions",
        Object.freeze({
          status: "observed",
          observation: Object.freeze({
            ...OBSERVED_COVER,
            naturalWidth: OBSERVED_COVER.naturalWidth + 1,
          }),
        }),
      ],
      ["no observed cover", Object.freeze({ status: "none" })],
    ];
    for (const [name, postApply] of cases) {
      let observeCalls = 0;
      const fixture = coverStageDeps({
        async observeCover(_page, editUrl, expectedWidth, expectedHeight) {
          observeCalls += 1;
          assert.equal(editUrl, EDIT_URL, name);
          assert.equal(expectedWidth, cover.width, name);
          assert.equal(expectedHeight, cover.height, name);
          return observeCalls === 1
            ? Object.freeze({ status: "none" })
            : postApply;
        },
      });
      const handoff = await stageArticleCover({} as Page, cover, fixture.deps);
      assert.equal(handoff.set, true, name);
      assert.equal(handoff.applyPhase, "returned", name);
      assert.equal(handoff.observed, false, name);
      assert.equal(handoff.verified, null, name);
      assert.equal(observeCalls, 2, name);
      assert.equal(
        fixture.calls.filter((call) => call === "apply-returned").length,
        1,
        name,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected Apply click is failed, attempted once, and never observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-apply-rejected-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);
    let clickCalls = 0;
    const fixture = coverStageDeps({
      async locateApply() {
        return {
          async click() {
            clickCalls += 1;
            throw new Error("possibly effective Apply rejection");
          },
        } as unknown as ElementHandle<HTMLElement>;
      },
    });
    const handoff = await stageArticleCover({} as Page, cover, fixture.deps);
    assert.equal(handoff.set, true);
    assert.equal(handoff.applyPhase, "failed");
    assert.equal(handoff.observed, false);
    assert.equal(handoff.verified, null);
    assert.equal(clickCalls, 1);
    assert.equal(fixture.calls.includes("settle-apply"), false);
    assert.equal(
      fixture.calls.filter((call) => call === "observe-cover").length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale cover, body media ambiguity, or a pre-existing dialog blocks the set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-cover-stale-baseline-"));
  try {
    const path = join(dir, "cover.png");
    writeFileSync(path, VALID_TINY_PNG);
    const cover = preloadXArticleCover(path);
    const cases: Array<readonly [string, Partial<ArticleCoverStageDependencies>]> = [
      ["stale qualifying cover", {
        async observeCover() {
          return Object.freeze({ status: "observed", observation: OBSERVED_COVER });
        },
      }],
      ["body media ambiguity", {
        async observeCover() {
          return Object.freeze({ status: "invalid" });
        },
      }],
      ["pre-existing active dialog", {
        async activeDialogCount() { return 1; },
      }],
    ];
    for (const [name, overrides] of cases) {
      let setCalls = 0;
      const fixture = coverStageDeps({
        ...overrides,
        async resolveTarget() {
          return Object.freeze({
            editUrl: EDIT_URL,
            input: {
              async setInputFiles() { setCalls += 1; },
            } as unknown as ElementHandle<HTMLInputElement>,
          });
        },
      });
      const handoff = await stageArticleCover({} as Page, cover, fixture.deps);
      assert.equal(handoff.set, false, name);
      assert.equal(handoff.setPhase, "target_unavailable", name);
      assert.equal(handoff.applyPhase, "not_reached", name);
      assert.equal(handoff.observed, false, name);
      assert.equal(setCalls, 0, name);
      assert.equal(fixture.calls.includes("locate-apply"), false, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
