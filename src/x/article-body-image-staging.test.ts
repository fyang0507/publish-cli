import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserContext,
  ElementHandle,
  Locator,
  Page,
} from "playwright";
import { generateContent, type ArticleBlock } from "./content.js";
import { preloadXArticleCover } from "./articleCover.js";
import {
  preloadXArticleBodyImages,
  type XArticleBodyImagePreloadSet,
} from "./articleBodyImages.js";
import type { XArticleStageTextSegment } from "./articleStageSnapshot.js";
import {
  observeCalibratedArticleBodyImages,
  sameArticleBodyImageObservations,
  stageArticleBodyImages,
  stageArticleDraft,
  verifyArticleDraftSaved,
  type ArticleDraftStageDependencies,
  type ArticleBodyImageStageDependencies,
  type XArticleBodyImageVisualObservation,
  type XArticleBodyMediaTarget,
} from "./draftPoster.js";
import type { XArticleCoverHandoff } from "./saveProgress.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAIAAAAfCIEKAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADklEQVR4nGNkQAUsaHwAAIAABtETi70AAAAASUVORK5CYII=",
  "base64",
);
// Valid same-dimension PNG with the ancillary pHYs chunk removed, modeling X's
// deterministic native rewrite without changing the rendered media.
const NATIVE_REWRITTEN_PNG = Buffer.concat([PNG.subarray(0, 33), PNG.subarray(54)]);

const CTX = {} as BrowserContext;
const PAGE = {} as Page;
const BODY = {} as Locator;
const EDIT_URL = "https://x.com/compose/articles/edit/123";

function segment(index: number, value: string): Readonly<XArticleStageTextSegment> {
  const html = value === "" ? "" : `<p>${value}</p>`;
  const plain = value;
  return Object.freeze({
    index,
    html,
    plain,
    sourceSha256: createHash("sha256")
      .update(`${html.length}:${html}${plain.length}:${plain}`, "utf8")
      .digest("hex"),
  });
}

function observation(identity: string): Readonly<XArticleBodyImageVisualObservation> {
  return Object.freeze({
    sourceIdentitySha256: createHash("sha256").update(identity, "utf8").digest("hex"),
    naturalWidth: 5,
    naturalHeight: 2,
  });
}

function target(index: number): Readonly<XArticleBodyMediaTarget> {
  return Object.freeze({
    input: { index } as unknown as ElementHandle<HTMLInputElement>,
    editUrl: EDIT_URL,
  });
}

function duplicatePreloads(
  count: number,
): { dir: string; images: Readonly<XArticleBodyImagePreloadSet> } {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-stage-"));
  writeFileSync(join(dir, "body.png"), PNG);
  const blocks: ArticleBlock[] = [];
  for (let index = 1; index <= count; index += 1) {
    if (index > 1) blocks.push({ kind: "paragraph", runs: [{ text: `gap-${index}` }] });
    blocks.push({ kind: "image", index, source: "body.png", alt: "" });
  }
  return { dir, images: preloadXArticleBodyImages(blocks, dir) };
}

class FakeDomNode {
  static readonly TEXT_NODE = 3;
  readonly nodeType: number;
  readonly nodeValue: string | null;
  parentElement: FakeDomElement | null = null;

  constructor(nodeType: number, nodeValue: string | null = null) {
    this.nodeType = nodeType;
    this.nodeValue = nodeValue;
  }
}

class FakeDomElement extends FakeDomNode {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly childNodes: FakeDomNode[] = [];
  readonly display: string;
  isConnected = true;
  boxWidth = 100;
  boxHeight = 50;

  constructor(tag: string, attributes: Readonly<Record<string, string>> = {}) {
    super(1);
    this.tag = tag;
    this.attributes = attributes;
    this.display = tag === "img" || tag === "span" ? "inline" : "block";
  }

  append(...children: FakeDomNode[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.childNodes.push(child);
    }
    return this;
  }

  get children(): FakeDomElement[] {
    return this.childNodes.filter((child): child is FakeDomElement =>
      child instanceof FakeDomElement);
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  matches(selector: string): boolean {
    if (selector === 'div[data-testid="composer"][contenteditable="true"]') {
      return this.tag === "div" && this.getAttribute("data-testid") === "composer" &&
        this.getAttribute("contenteditable") === "true";
    }
    if (selector === 'div[role="button"][aria-describedby]') {
      return this.tag === "div" && this.getAttribute("role") === "button" &&
        this.getAttribute("aria-describedby") !== null;
    }
    if (selector === 'section[contenteditable="false"]') {
      return this.tag === "section" && this.getAttribute("contenteditable") === "false";
    }
    if (selector === 'div[role="group"][aria-label="Media"]') {
      return this.tag === "div" && this.getAttribute("role") === "group" &&
        this.getAttribute("aria-label") === "Media";
    }
    if (selector === "img") return this.tag === "img";
    return false;
  }

  closest(selector: string): FakeDomElement | null {
    let candidate: FakeDomElement | null = this;
    while (candidate !== null) {
      if (candidate.matches(selector)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  contains(candidate: FakeDomNode): boolean {
    if (candidate === this) return true;
    return this.childNodes.some((child) =>
      child === candidate ||
      (child instanceof FakeDomElement && child.contains(candidate)));
  }

  querySelectorAll(selector: string): FakeDomElement[] {
    const matches: FakeDomElement[] = [];
    const visit = (node: FakeDomNode): void => {
      if (!(node instanceof FakeDomElement)) return;
      if (node.matches(selector)) matches.push(node);
      for (const child of node.childNodes) visit(child);
    };
    for (const child of this.childNodes) visit(child);
    return matches;
  }

  getBoundingClientRect(): Readonly<{ width: number; height: number }> {
    return { width: this.boxWidth, height: this.boxHeight };
  }
}

class FakeDomImage extends FakeDomElement {
  src: string;
  currentSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  complete = true;

  constructor(src: string, naturalWidth = 5, naturalHeight = 2) {
    super("img");
    this.src = src;
    this.currentSrc = src;
    this.naturalWidth = naturalWidth;
    this.naturalHeight = naturalHeight;
  }
}

const MEDIA_UI_TEXT = " Native media controls are UI text ";

function textNode(value: string): FakeDomNode {
  return new FakeDomNode(FakeDomNode.TEXT_NODE, value);
}

function calibratedBodyDom(src: string, neutralWrapper = false): {
  root: FakeDomElement;
  image: FakeDomImage;
} {
  const root = new FakeDomElement("div", {
    "data-testid": "composer",
    contenteditable: "true",
  });
  const paragraph = new FakeDomElement("p").append(textNode("Before"));
  const image = new FakeDomImage(src);
  const mediaGroup = new FakeDomElement("div", {
    role: "group",
    "aria-label": "Media",
  }).append(new FakeDomElement("div").append(image));
  const nonEditableSection = new FakeDomElement("section", {
    contenteditable: "false",
  }).append(mediaGroup, textNode(MEDIA_UI_TEXT));
  const mediaButton = new FakeDomElement("div", {
    role: "button",
    "aria-describedby": "calibrated-media-description",
  }).append(nonEditableSection);
  const mediaContainer = neutralWrapper
    ? new FakeDomElement("div").append(mediaButton)
    : mediaButton;
  return { root: root.append(paragraph, mediaContainer), image };
}

function bodyObservationPage(
  root: FakeDomElement,
  bodyInnerText = `Before${MEDIA_UI_TEXT}`,
): Page {
  let currentUrl = EDIT_URL;
  const body = {
    async count() { return 1; },
    nth() { return body; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async innerText() { return bodyInnerText; },
    async evaluate<Result>(
      callback: (element: HTMLElement) => Result | Promise<Result>,
    ): Promise<Result> {
      return callback(root as unknown as HTMLElement);
    },
  };
  const title = {
    async count() { return 1; },
    nth() { return title; },
    async isVisible() { return true; },
    async isEnabled() { return true; },
    async inputValue() { return "Native title"; },
  };
  return {
    async goto(url: string) {
      currentUrl = url;
      return null;
    },
    url() { return currentUrl; },
    async waitForTimeout() {},
    locator(selector: string) {
      return selector.includes("textarea") ? title : body;
    },
  } as unknown as Page;
}

async function withFakeBrowserDom<Result>(
  fetchBlob: (src: string) => Promise<Response>,
  action: () => Promise<Result>,
): Promise<Result> {
  const keys = ["Node", "Element", "HTMLImageElement", "window", "fetch"] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>(keys.map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    Node: { configurable: true, writable: true, value: FakeDomNode },
    Element: { configurable: true, writable: true, value: FakeDomElement },
    HTMLImageElement: { configurable: true, writable: true, value: FakeDomImage },
    window: {
      configurable: true,
      writable: true,
      value: {
        location: { origin: "https://x.com" },
        getComputedStyle(element: FakeDomElement) {
          return { display: element.display, visibility: "visible" };
        },
      },
    },
    fetch: {
      configurable: true,
      writable: true,
      value: async (input: string | URL | Request) => fetchBlob(String(input)),
    },
  });
  try {
    return await action();
  } finally {
    for (const key of keys) {
      const descriptor = originals.get(key);
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }
}

test("calibrated rewritten native blob media excludes UI text and remains stable across reopen", async () => {
  const { dir, images } = duplicatePreloads(1);
  try {
    assert.equal([...MEDIA_UI_TEXT.trim()].length, 33);
    const segments = [segment(0, "Before"), segment(1, "")];
    const beforeDom = calibratedBodyDom("blob:https://x.com/before-fixture");
    const afterDom = calibratedBodyDom("blob:https://x.com/after-fixture");
    let fetchCount = 0;
    await withFakeBrowserDom(
      async (src) => {
        assert.match(src, /^blob:https:\/\/x\.com\//u);
        fetchCount += 1;
        return new Response(new Uint8Array(NATIVE_REWRITTEN_PNG), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      },
      async () => {
        const before = await observeCalibratedArticleBodyImages(
          bodyObservationPage(beforeDom.root),
          EDIT_URL,
          segments,
          images.occurrences,
        );
        const after = await observeCalibratedArticleBodyImages(
          bodyObservationPage(afterDom.root),
          EDIT_URL,
          segments,
          images.occurrences,
        );
        assert.equal(before.status, "observed");
        assert.equal(after.status, "observed");
        if (before.status !== "observed" || after.status !== "observed") return;
        assert.equal(sameArticleBodyImageObservations(before.images, after.images), true);
        assert.equal(before.images[0].naturalWidth, 5);
        assert.equal(before.images[0].naturalHeight, 2);
        const nativeSha256 = createHash("sha256").update(NATIVE_REWRITTEN_PNG).digest("hex");
        const nativeIdentitySha256 = createHash("sha256")
          .update("x-article-body-image:blob-bytes:v1:", "utf8")
          .update(nativeSha256, "utf8")
          .digest("hex");
        assert.notEqual(nativeSha256, images.occurrences[0].bytes.sourceSha256);
        assert.notEqual(NATIVE_REWRITTEN_PNG.length, images.occurrences[0].bytes.sizeBytes);
        assert.equal(before.images[0].sourceIdentitySha256, nativeIdentitySha256);

        assert.equal(await verifyArticleDraftSaved(
          bodyObservationPage(afterDom.root),
          EDIT_URL,
          "Native title",
          "Before",
          Object.freeze({ segments, images: images.occurrences }),
        ), true, "image-bearing verification uses exact segments, not native media UI innerText");
        assert.equal(await verifyArticleDraftSaved(
          bodyObservationPage(afterDom.root),
          EDIT_URL,
          "Native title",
          "Before",
        ), false, "raw innerText remains non-authoritative when native media UI text is present");
      },
    );
    assert.equal(fetchCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calibrated body media remains uniquely owned through a neutral composer wrapper", async () => {
  const { dir, images } = duplicatePreloads(1);
  try {
    const segments = [segment(0, "Before"), segment(1, "")];
    const dom = calibratedBodyDom("blob:https://x.com/wrapped-fixture", true);
    await withFakeBrowserDom(
      async () => new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
      async () => {
        const observed = await observeCalibratedArticleBodyImages(
          bodyObservationPage(dom.root),
          EDIT_URL,
          segments,
          images.occurrences,
        );
        assert.equal(observed.status, "observed");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one-shot delivery binds the first deterministic rewritten native blob identity", async () => {
  const { dir, images } = duplicatePreloads(1);
  try {
    const segments = [segment(0, "Before"), segment(1, "")];
    const dom = calibratedBodyDom("blob:https://x.com/one-shot-native-rewrite", true);
    const page = bodyObservationPage(dom.root);
    let resolveCount = 0;
    let setCount = 0;
    let observeCount = 0;
    await withFakeBrowserDom(
      async () => new Response(new Uint8Array(NATIVE_REWRITTEN_PNG), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
      async () => {
        const result = await stageArticleBodyImages(
          CTX,
          page,
          BODY,
          EDIT_URL,
          segments,
          images,
          {
            async appendSegment() { return true; },
            async resolveTarget() {
              resolveCount += 1;
              return target(1);
            },
            async setTarget(_page, _body, _target, occurrence) {
              setCount += 1;
              assert.equal(occurrence, images.occurrences[0]);
              return "set_returned";
            },
            async observe(_page, editUrl, expectedSegments, expectedImages) {
              observeCount += 1;
              return observeCalibratedArticleBodyImages(
                page,
                editUrl,
                expectedSegments,
                expectedImages,
              );
            },
          },
        );
        const nativeSha256 = createHash("sha256").update(NATIVE_REWRITTEN_PNG).digest("hex");
        const nativeIdentitySha256 = createHash("sha256")
          .update("x-article-body-image:blob-bytes:v1:", "utf8")
          .update(nativeSha256, "utf8")
          .digest("hex");
        assert.equal(resolveCount, 1);
        assert.equal(setCount, 1);
        assert.equal(observeCount, 2);
        assert.equal(result.handoffs[0].sourceSha256, images.occurrences[0].bytes.sourceSha256);
        assert.equal(result.handoffs[0].sourceIdentitySha256, nativeIdentitySha256);
        assert.deepEqual(result.beforeReload, [
          {
            sourceIdentitySha256: nativeIdentitySha256,
            naturalWidth: 5,
            naturalHeight: 2,
          },
        ]);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body media rejects arbitrary blobs, empty bytes, MIME/dimension mismatch, and async substitution", async () => {
  const { dir, images } = duplicatePreloads(1);
  try {
    const segments = [segment(0, "Before"), segment(1, "")];
    const arbitraryRoot = new FakeDomElement("div").append(
      new FakeDomElement("p").append(textNode("Before")),
      new FakeDomImage("blob:https://x.com/arbitrary-fixture"),
    );
    await withFakeBrowserDom(
      async () => new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
      async () => {
        assert.deepEqual(await observeCalibratedArticleBodyImages(
          bodyObservationPage(arbitraryRoot),
          EDIT_URL,
          segments,
          images.occurrences,
        ), { status: "invalid" });
      },
    );

    for (const [name, bytes, contentType] of [
      ["empty", Buffer.alloc(0), "image/png"],
      ["MIME", PNG, "image/jpeg"],
    ] as const) {
      const dom = calibratedBodyDom(`blob:https://x.com/${name.toLowerCase()}-mismatch`);
      await withFakeBrowserDom(
        async () => new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "content-type": contentType },
        }),
        async () => {
          assert.deepEqual(await observeCalibratedArticleBodyImages(
            bodyObservationPage(dom.root),
            EDIT_URL,
            segments,
            images.occurrences,
          ), { status: "invalid" }, name);
        },
      );
    }

    const wrongDimensions = calibratedBodyDom("blob:https://x.com/dimension-mismatch");
    wrongDimensions.image.naturalWidth = 6;
    await withFakeBrowserDom(
      async () => new Response(new Uint8Array(NATIVE_REWRITTEN_PNG), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
      async () => {
        assert.deepEqual(await observeCalibratedArticleBodyImages(
          bodyObservationPage(wrongDimensions.root),
          EDIT_URL,
          segments,
          images.occurrences,
        ), { status: "invalid" });
      },
    );

    const substituted = calibratedBodyDom("blob:https://x.com/pre-fetch-fixture");
    await withFakeBrowserDom(
      async () => {
        substituted.image.currentSrc = "blob:https://x.com/substituted-during-fetch";
        return new Response(new Uint8Array(PNG), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      },
      async () => {
        assert.deepEqual(await observeCalibratedArticleBodyImages(
          bodyObservationPage(substituted.root),
          EDIT_URL,
          segments,
          images.occurrences,
        ), { status: "invalid" });
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed rewritten native blob digest and size fail reopen identity parity", async () => {
  const { dir, images } = duplicatePreloads(1);
  try {
    const segments = [segment(0, "Before"), segment(1, "")];
    const beforeDom = calibratedBodyDom("blob:https://x.com/native-before");
    const afterDom = calibratedBodyDom("blob:https://x.com/native-after");
    await withFakeBrowserDom(
      async (src) => new Response(new Uint8Array(
        src.endsWith("native-before") ? NATIVE_REWRITTEN_PNG : PNG,
      ), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
      async () => {
        const before = await observeCalibratedArticleBodyImages(
          bodyObservationPage(beforeDom.root),
          EDIT_URL,
          segments,
          images.occurrences,
        );
        const after = await observeCalibratedArticleBodyImages(
          bodyObservationPage(afterDom.root),
          EDIT_URL,
          segments,
          images.occurrences,
        );
        assert.equal(before.status, "observed");
        assert.equal(after.status, "observed");
        if (before.status !== "observed" || after.status !== "observed") return;
        assert.notEqual(NATIVE_REWRITTEN_PNG.length, PNG.length);
        assert.notEqual(
          before.images[0].sourceIdentitySha256,
          after.images[0].sourceIdentitySha256,
        );
        assert.equal(sameArticleBodyImageObservations(before.images, after.images), false);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body media identity is domain-separated when native source kind changes", async () => {
  const { dir, images } = duplicatePreloads(1);
  try {
    const segments = [segment(0, "Before"), segment(1, "")];
    const blobDom = calibratedBodyDom("blob:https://x.com/blob-fixture");
    const hostedDom = calibratedBodyDom("https://pbs.twimg.com/media/hosted-fixture?format=png");
    await withFakeBrowserDom(
      async () => new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
      async () => {
        const blob = await observeCalibratedArticleBodyImages(
          bodyObservationPage(blobDom.root),
          EDIT_URL,
          segments,
          images.occurrences,
        );
        const hosted = await observeCalibratedArticleBodyImages(
          bodyObservationPage(hostedDom.root),
          EDIT_URL,
          segments,
          images.occurrences,
        );
        assert.equal(blob.status, "observed");
        assert.equal(hosted.status, "observed");
        if (blob.status !== "observed" || hosted.status !== "observed") return;
        assert.equal(sameArticleBodyImageObservations(blob.images, hosted.images), false);
        assert.notEqual(blob.images[0].sourceIdentitySha256, hosted.images[0].sourceIdentitySha256);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("body-image staging appends N+1 segments and sets each duplicate occurrence exactly once in order", async () => {
  const { dir, images } = duplicatePreloads(2);
  try {
    const segments = [segment(0, "before"), segment(1, "between"), segment(2, "after")];
    const first = observation("remote-first");
    const second = observation("remote-second");
    const events: string[] = [];
    let targetIndex = 0;
    const dependencies: ArticleBodyImageStageDependencies = {
      async appendSegment(_ctx, _page, _body, editUrl, value) {
        assert.equal(editUrl, EDIT_URL);
        events.push(`append:${value.index}`);
        return true;
      },
      async resolveTarget(_page, _body, editUrl) {
        assert.equal(editUrl, EDIT_URL);
        events.push(`target:${targetIndex + 1}`);
        targetIndex += 1;
        return target(targetIndex);
      },
      async setTarget(_page, _body, resolved, occurrence) {
        events.push(`set:${occurrence.occurrenceIndex}`);
        assert.equal((resolved.input as unknown as { index: number }).index, occurrence.occurrenceIndex);
        assert.equal(occurrence.bytes, images.occurrences[0].bytes);
        return "set_returned";
      },
      async observe(_page, editUrl, expectedSegments, expectedImages) {
        assert.equal(editUrl, EDIT_URL);
        events.push(`observe:${expectedImages.length}:${expectedSegments.length}`);
        assert.equal(expectedSegments.length, expectedImages.length + 1);
        if (expectedImages.length === 1) {
          assert.deepEqual(expectedSegments.map(({ index }) => index), [0, 1]);
          assert.equal(expectedSegments[1].plain, "");
          return Object.freeze({ status: "observed", images: Object.freeze([first]) });
        }
        assert.deepEqual(expectedSegments.map(({ index }) => index), [0, 1, 2]);
        return Object.freeze({ status: "observed", images: Object.freeze([first, second]) });
      },
    };

    const result = await stageArticleBodyImages(
      CTX,
      PAGE,
      BODY,
      EDIT_URL,
      segments,
      images,
      dependencies,
    );

    assert.deepEqual(events, [
      "append:0",
      "target:1",
      "set:1",
      "observe:1:2",
      "append:1",
      "target:2",
      "set:2",
      "observe:2:3",
      "append:2",
      "observe:2:3",
    ]);
    assert.equal(result.handoffs.length, 2);
    assert.deepEqual(result.handoffs.map(({ occurrenceIndex }) => occurrenceIndex), [1, 2]);
    assert.equal(result.handoffs[0].sourceSha256, result.handoffs[1].sourceSha256);
    assert.deepEqual(
      result.handoffs.map(({ set, setPhase, observed, sourceIdentitySha256 }) => ({
        set,
        setPhase,
        observed,
        sourceIdentitySha256,
      })),
      [
        { set: true, setPhase: "set_returned", observed: true, sourceIdentitySha256: first.sourceIdentitySha256 },
        { set: true, setPhase: "set_returned", observed: true, sourceIdentitySha256: second.sourceIdentitySha256 },
      ],
    );
    assert.deepEqual(result.beforeReload, [first, second]);
    assert.equal(Object.isFrozen(result.beforeReload), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later unavailable target closes the current receipt and leaves all later occurrences untouched", async () => {
  const { dir, images } = duplicatePreloads(3);
  try {
    const events: string[] = [];
    const first = observation("remote-first");
    const dependencies: ArticleBodyImageStageDependencies = {
      async appendSegment(_ctx, _page, _body, _editUrl, value) {
        events.push(`append:${value.index}`);
        return true;
      },
      async resolveTarget() {
        const attempt = events.filter((event) => event.startsWith("target:")).length + 1;
        events.push(`target:${attempt}`);
        return attempt === 1 ? target(1) : null;
      },
      async setTarget(_page, _body, _target, occurrence) {
        events.push(`set:${occurrence.occurrenceIndex}`);
        return "set_returned";
      },
      async observe(_page, _editUrl, _segments, expectedImages) {
        events.push(`observe:${expectedImages.length}`);
        return Object.freeze({ status: "observed", images: Object.freeze([first]) });
      },
    };

    const result = await stageArticleBodyImages(
      CTX,
      PAGE,
      BODY,
      EDIT_URL,
      [segment(0, "a"), segment(1, "b"), segment(2, "c"), segment(3, "d")],
      images,
      dependencies,
    );

    assert.deepEqual(events, [
      "append:0",
      "target:1",
      "set:1",
      "observe:1",
      "append:1",
      "target:2",
    ]);
    assert.deepEqual(result.handoffs.map(({ set, setPhase, observed }) => ({ set, setPhase, observed })), [
      { set: true, setPhase: "set_returned", observed: true },
      { set: false, setPhase: "target_unavailable", observed: false },
      { set: false, setPhase: "not_attempted", observed: false },
    ]);
    assert.equal(result.beforeReload, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected set is delivery-unknown, is not retried, and suppresses all later delivery", async () => {
  const { dir, images } = duplicatePreloads(3);
  try {
    const first = observation("remote-first");
    const setAttempts: number[] = [];
    let resolved = 0;
    const dependencies: ArticleBodyImageStageDependencies = {
      async appendSegment() {
        return true;
      },
      async resolveTarget() {
        resolved += 1;
        return target(resolved);
      },
      async setTarget(_page, _body, _target, occurrence) {
        setAttempts.push(occurrence.occurrenceIndex);
        if (occurrence.occurrenceIndex === 2) throw new Error("ambiguous delivery");
        return "set_returned";
      },
      async observe() {
        return Object.freeze({ status: "observed", images: Object.freeze([first]) });
      },
    };

    const result = await stageArticleBodyImages(
      CTX,
      PAGE,
      BODY,
      EDIT_URL,
      [segment(0, "a"), segment(1, "b"), segment(2, "c"), segment(3, "d")],
      images,
      dependencies,
    );

    assert.deepEqual(setAttempts, [1, 2]);
    assert.equal(resolved, 2);
    assert.deepEqual(result.handoffs.map(({ set, setPhase, observed }) => ({ set, setPhase, observed })), [
      { set: true, setPhase: "set_returned", observed: true },
      { set: null, setPhase: "set_delivery_unknown", observed: false },
      { set: false, setPhase: "not_attempted", observed: false },
    ]);
    assert.equal(result.beforeReload, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const failure of ["absent", "reordered", "identity_changed"] as const) {
  test(`returned set stops on ${failure.replace("_", " ")} observation evidence`, async () => {
    const count = failure === "absent" ? 2 : 3;
    const { dir, images } = duplicatePreloads(count);
    try {
      const first = observation("remote-first");
      const second = observation("remote-second");
      let setCount = 0;
      let observeCount = 0;
      const dependencies: ArticleBodyImageStageDependencies = {
        async appendSegment() {
          return true;
        },
        async resolveTarget() {
          return target(setCount + 1);
        },
        async setTarget() {
          setCount += 1;
          return "set_returned";
        },
        async observe() {
          observeCount += 1;
          if (failure === "absent") return Object.freeze({ status: "none" });
          if (observeCount === 1) {
            return Object.freeze({ status: "observed", images: Object.freeze([first]) });
          }
          const changed = failure === "reordered"
            ? [second, first]
            : [observation("changed-first"), second];
          return Object.freeze({ status: "observed", images: Object.freeze(changed) });
        },
      };

      const segments = Array.from({ length: count + 1 }, (_, index) => segment(index, `s${index}`));
      const result = await stageArticleBodyImages(
        CTX,
        PAGE,
        BODY,
        EDIT_URL,
        segments,
        images,
        dependencies,
      );

      assert.equal(setCount, failure === "absent" ? 1 : 2);
      const failedIndex = failure === "absent" ? 0 : 1;
      assert.equal(result.handoffs[failedIndex].set, true);
      assert.equal(result.handoffs[failedIndex].setPhase, "set_returned");
      assert.equal(result.handoffs[failedIndex].observed, false);
      assert.equal(result.handoffs[failedIndex].sourceIdentitySha256, null);
      assert.equal(result.handoffs.at(-1)?.setPhase, count > failedIndex + 1 ? "not_attempted" : "set_returned");
      assert.equal(result.beforeReload, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("Create orchestration stages cover before body and gates success on reopen image proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-x-body-orchestration-"));
  try {
    writeFileSync(join(dir, "cover.png"), PNG);
    writeFileSync(join(dir, "body.png"), PNG);
    const content = await generateContent(
      "# Native title\n\nBefore.\n\n![](body.png)\n\nAfter.\n",
      { format: "article" },
    );
    const cover = preloadXArticleCover(join(dir, "cover.png"));
    const images = preloadXArticleBodyImages(content.article!.blocks, dir);
    const observed = observation("remote-body");

    for (const bodyReopenVerified of [true, false]) {
      const events: string[] = [];
      const locator = {} as Locator;
      const stagedCover: XArticleCoverHandoff = {
        selection: "explicit",
        contentType: cover.contentType,
        width: cover.width,
        height: cover.height,
        ratio: "exact_5_2",
        sourceSha256: cover.sourceSha256,
        requested: true,
        resolved: true,
        set: true,
        setPhase: "set_returned",
        uploaded: null,
        applyPhase: "delivery_unknown",
        observed: false,
        verified: null,
      };
      const bodyDependencies: ArticleBodyImageStageDependencies = {
        async appendSegment(_ctx, _page, _body, _editUrl, value) {
          events.push(`body:append:${value.index}`);
          return true;
        },
        async resolveTarget() {
          events.push("body:target");
          return target(1);
        },
        async setTarget() {
          events.push("body:set");
          return "set_returned";
        },
        async observe() {
          events.push("body:observe");
          return Object.freeze({ status: "observed", images: Object.freeze([observed]) });
        },
      };
      const dependencies: ArticleDraftStageDependencies = {
        async openHub() { events.push("hub"); },
        async locateCreate() {
          events.push("create:locate");
          return { async click() { events.push("create:click"); } } as unknown as Locator;
        },
        currentEditUrl() { return EDIT_URL; },
        async settledEditUrl() { return EDIT_URL; },
        async locateTitle() { events.push("title:locate"); return locator; },
        async writeTitle() { events.push("title:write"); },
        async locateBody() { events.push("body:locate"); return locator; },
        async writeBody() { assert.fail("image-bearing flow must not paste the full body"); },
        async stageCover() { events.push("cover:stage"); return stagedCover; },
        bodyImages: bodyDependencies,
        async settle() { events.push("settle"); },
        async verify(_page, _url, _title, _body, _width, _height, proof) {
          events.push("verify");
          assert.deepEqual(proof?.beforeReload, [observed]);
          assert.equal(proof?.images, images);
          return { content: true, cover: true, bodyImages: [bodyReopenVerified] };
        },
      };

      const result = await stageArticleDraft(
        CTX,
        PAGE,
        content,
        cover,
        dependencies,
        images,
      );
      assert.equal(events.indexOf("cover:stage") < events.indexOf("body:append:0"), true);
      assert.equal(events.filter((event) => event === "body:set").length, 1);
      assert.equal(result.saveMechanism, "article_create_autosave");
      if (result.saveMechanism !== "article_create_autosave") assert.fail("expected Article");
      assert.equal(result.articleHandoff.body, "segmented_rich_html");
      assert.equal(result.articleHandoff.cover.verified, true);
      assert.equal(result.articleHandoff.cover.applyPhase, "delivery_unknown");
      assert.equal(result.articleHandoff.bodyImages[0].verified, bodyReopenVerified);
      assert.equal(result.savePhase, bodyReopenVerified ? "verified" : "save_delivered_unverified");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
