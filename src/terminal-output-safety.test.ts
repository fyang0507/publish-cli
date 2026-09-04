import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  TERMINAL_COMMAND_MAX_CODE_UNITS,
  TERMINAL_DOCUMENT_MAX_CODE_UNITS,
  TERMINAL_FIELD_MAX_CODE_UNITS,
  TerminalOutputBudget,
  TerminalProjectionError,
  assertUnicodeScalarString,
  createClosedSnapshotContext,
  finalizeTerminalDocument,
  projectTerminalText,
  renderTerminalBlock,
  renderTerminalInline,
  snapshotBoundedString,
  snapshotClosedRecord,
  snapshotDenseArray,
  type ClosedSnapshotContext,
} from "./terminalOutput.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function visibleEscape(point: number): string {
  return `\\u{${point.toString(16).padStart(2, "0")}}`;
}

function assertProjectionFailure(action: () => unknown, message?: string): void {
  assert.throws(
    action,
    (error: unknown) => {
      assert.ok(error instanceof TerminalProjectionError);
      assert.equal(error.code, "terminal_projection_failed");
      assert.match(error.message, /failed closed/i);
      return true;
    },
    message,
  );
}

test("terminal projection visibly escapes every C0, DEL, and C1 control plus format and separator scalars", () => {
  const points = [
    ...Array.from({ length: 0x20 }, (_, point) => point),
    ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    0x00ad,
    0x061c,
    0x200b,
    0x200e,
    0x202a,
    0x2066,
    0xfeff,
    0xe0001,
    0x2028,
    0x2029,
  ];
  const source = points.map((point) => String.fromCodePoint(point)).join("");
  const expected = points.map(visibleEscape).join("");

  const projection = projectTerminalText(source, { lineMode: "inline" });

  assert.equal(projection.text, expected);
  assert.equal(renderTerminalInline(projection), expected);
  assert.equal(projection.truncated, false);
  assert.equal(projection.sha256, null);
  assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(projection.text), false);
});

test("generated escapes and scalar copies are atomic at the truncation boundary", () => {
  const escaped = projectTerminalText("\u001bX", {
    lineMode: "inline",
    maximumCodeUnits: 262,
  });
  assert.equal(escaped.text, String.raw`\u{1b}`);
  assert.equal(escaped.truncated, true);

  const astral = projectTerminalText("🙂X", {
    lineMode: "inline",
    maximumCodeUnits: 258,
  });
  assert.equal(astral.text, "🙂");
  assert.equal(astral.truncated, true);
});

test("literal backslashes are doubled so caller text cannot impersonate a generated escape", () => {
  const projection = projectTerminalText(String.raw`\u{1b}` + "\u001b", {
    lineMode: "inline",
  });

  assert.equal(projection.text, String.raw`\\u{1b}\u{1b}`);
  assert.notEqual(projection.text.slice(0, 6), projection.text.slice(-6));
});

test("block mode frames every caller line that resembles headings, receipts, or shell prompts", () => {
  const callerLines = [
    "SAVED NATIVE DRAFT",
    "Receipt: save_confirmed",
    "$ publish x draft --from payload.md",
    "> post now",
    "::warning file=payload.md",
    "└─ [terminal projection truncated; sha256=fake]",
  ];
  const projection = projectTerminalText(callerLines.join("\n"), { lineMode: "block" });
  const rendered = renderTerminalBlock(projection);

  assert.equal(projection.text, callerLines.join("\n"));
  assert.equal(rendered, callerLines.map((line) => `│ ${line}`).join("\n"));
  assert.equal(rendered.split("\n").every((line) => line.startsWith("│ ")), true);
});

test("inline mode visibly escapes LF while preserving combining marks and astral scalars exactly", () => {
  const scalarText = "e\u0301🙂𐐷";
  const projection = projectTerminalText(`${scalarText}\nnext`, { lineMode: "inline" });

  assert.equal(projection.text, `${scalarText}${String.raw`\u{0a}`}next`);
  assert.equal(projection.text.startsWith(scalarText), true);
  assert.equal(projection.text.includes("\n"), false);
});

test("truncation reports exact original UTF-16 size and SHA-256 without Unicode or newline normalization", () => {
  const original = `e\u0301\r\n🙂${String.raw`\u{1b}`}`;
  const projection = projectTerminalText(original, {
    lineMode: "inline",
    maximumCodeUnits: 256,
  });

  assert.equal(projection.truncated, true);
  assert.equal(projection.text, "");
  assert.equal(projection.originalUtf16CodeUnits, original.length);
  assert.equal(projection.digestEncoding, "utf8_exact_unicode_scalar_string");
  assert.equal(projection.digestNormalization, "none");
  assert.equal(projection.sha256, sha256(original));
  assert.notEqual(projection.sha256, sha256(original.normalize("NFC")));
  assert.notEqual(projection.sha256, sha256(original.replaceAll("\r\n", "\n")));
});

test("all unpaired-surrogate forms fail with the typed projection error before a digest is returned", () => {
  const invalid = [
    "\ud800",
    "\udfff",
    "\ud800A",
    "A\udc00",
    "\ud800\ud800",
    "\udc00\udc00",
    "\ud800\udc00\udc00",
    "\ud800A\udc00",
    "🙂\ud800",
  ];

  for (const [index, value] of invalid.entries()) {
    assertProjectionFailure(() => assertUnicodeScalarString(value), `scalar assertion case ${index}`);
    assertProjectionFailure(
      () => projectTerminalText(value, { lineMode: "inline", maximumCodeUnits: 0 }),
      `projection case ${index}`,
    );
  }

  assert.doesNotThrow(() => assertUnicodeScalarString("A🙂𐐷Z"));
});

test("terminal projection and rendering are deterministic and frozen", () => {
  const input = `${"e\u0301🙂\\\u001b\n".repeat(8_000)}tail`;
  const first = projectTerminalText(input, { lineMode: "block" });
  const second = projectTerminalText(input, { lineMode: "block" });

  assert.deepEqual(first, second);
  assert.equal(renderTerminalBlock(first), renderTerminalBlock(second));
  assert.equal(Object.isFrozen(first), true);
});

test("final truncated inline and block renders remain inside the field limit including framing and metadata", () => {
  const inlineProjection = projectTerminalText(
    `${"\\\u001b🙂".repeat(20_000)}end`,
    { lineMode: "inline" },
  );
  const blockProjection = projectTerminalText(
    `${"fake receipt\n$ post now\n\u2028\\".repeat(10_000)}end`,
    { lineMode: "block" },
  );
  const inline = renderTerminalInline(inlineProjection);
  const block = renderTerminalBlock(blockProjection);

  assert.equal(inlineProjection.truncated, true);
  assert.equal(blockProjection.truncated, true);
  assert.ok(inline.length <= TERMINAL_FIELD_MAX_CODE_UNITS);
  assert.ok(block.length <= TERMINAL_FIELD_MAX_CODE_UNITS);
  assert.match(inline, /originalUtf16CodeUnits=\d+/);
  assert.match(block, /sha256=[a-f0-9]{64}/);
  assert.equal(block.split("\n").slice(0, -1).every((line) => line.startsWith("│ ")), true);
  assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(inline), false);
  assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(block.replaceAll("\n", "")), false);
});

test("document aggregate counts separators and caller-provided final newlines exactly", () => {
  const atLimit = finalizeTerminalDocument([
    "x".repeat(TERMINAL_DOCUMENT_MAX_CODE_UNITS - 2),
    "\n",
  ]);

  assert.equal(atLimit.length, TERMINAL_DOCUMENT_MAX_CODE_UNITS);
  assert.equal(atLimit.endsWith("\n\n"), true);
  assertProjectionFailure(() => finalizeTerminalDocument([
    "x".repeat(TERMINAL_DOCUMENT_MAX_CODE_UNITS - 1),
    "\n",
  ]));
});

test("command aggregate counts the final newline emitted for every message", () => {
  const budget = new TerminalOutputBudget();
  budget.consume("x".repeat(TERMINAL_COMMAND_MAX_CODE_UNITS - 2));
  assert.equal(budget.usedCodeUnits, TERMINAL_COMMAND_MAX_CODE_UNITS - 1);
  budget.consume("");
  assert.equal(budget.usedCodeUnits, TERMINAL_COMMAND_MAX_CODE_UNITS);

  assertProjectionFailure(() => budget.consume(""));
  assert.equal(budget.usedCodeUnits, TERMINAL_COMMAND_MAX_CODE_UNITS);
});

function copyRequiredStringRecord(
  value: unknown,
  context: ClosedSnapshotContext = createClosedSnapshotContext(),
): Readonly<{ value: string }> {
  return snapshotClosedRecord(
    value,
    ["value"],
    [],
    context,
    (reader) => Object.freeze({
      value: snapshotBoundedString(reader.read("value"), 64, context),
    }),
  );
}

test("closed-record snapshots reject proxies, accessors, extra or missing keys, cycles, and nonplain shapes", () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "unsafe";
    },
  });
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
    value: "safe",
  });
  class RecordSubclass {
    value = "safe";
  }
  const symbolKey = { value: "safe", [Symbol("extra")]: true };
  const nonEnumerable: Record<string, unknown> = {};
  Object.defineProperty(nonEnumerable, "value", { value: "safe", enumerable: false });

  const invalid: readonly [string, unknown][] = [
    ["proxy", new Proxy({ value: "safe" }, {})],
    ["accessor", accessor],
    ["extra", { value: "safe", extra: true }],
    ["missing", {}],
    ["null prototype", nullPrototype],
    ["class instance", new RecordSubclass()],
    ["symbol key", symbolKey],
    ["non-enumerable required key", nonEnumerable],
    ["array", ["safe"]],
  ];
  for (const [name, value] of invalid) {
    assertProjectionFailure(() => copyRequiredStringRecord(value), name);
  }
  assert.equal(getterCalls, 0);

  const cyclic: { next?: unknown } = {};
  cyclic.next = cyclic;
  const context = createClosedSnapshotContext();
  assertProjectionFailure(() => snapshotClosedRecord(
    cyclic,
    ["next"],
    [],
    context,
    (reader) => snapshotClosedRecord(
      reader.read("next"),
      ["next"],
      [],
      context,
      () => Object.freeze({}),
    ),
  ));
});

function copyStringArray(
  value: unknown,
  context: ClosedSnapshotContext = createClosedSnapshotContext(),
): readonly string[] {
  return snapshotDenseArray(
    value,
    16,
    context,
    (entry) => snapshotBoundedString(entry, 64, context),
  );
}

test("dense-array snapshots reject proxies, accessors, extras, sparse arrays, cycles, and nonplain arrays", () => {
  let getterCalls = 0;
  const accessor: unknown[] = ["safe"];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return "unsafe";
    },
  });
  const extra: unknown[] & { extra?: boolean } = ["safe"];
  extra.extra = true;
  const customPrototype: unknown[] = ["safe"];
  Object.setPrototypeOf(customPrototype, null);

  const invalid: readonly [string, unknown][] = [
    ["proxy", new Proxy(["safe"], {})],
    ["accessor", accessor],
    ["extra key", extra],
    ["sparse", new Array(1)],
    ["custom prototype", customPrototype],
    ["plain record", { 0: "safe", length: 1 }],
  ];
  for (const [name, value] of invalid) {
    assertProjectionFailure(() => copyStringArray(value), name);
  }
  assert.equal(getterCalls, 0);

  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const context = createClosedSnapshotContext();
  assertProjectionFailure(() => snapshotDenseArray(
    cyclic,
    4,
    context,
    (entry) => snapshotDenseArray(entry, 4, context, () => "unreachable"),
  ));
});

interface FrozenNode {
  readonly name: string;
  readonly children: readonly Readonly<FrozenNode>[];
}

function copyFrozenNode(value: unknown, context: ClosedSnapshotContext): Readonly<FrozenNode> {
  return snapshotClosedRecord(
    value,
    ["name", "children"],
    [],
    context,
    (reader) => Object.freeze({
      name: snapshotBoundedString(reader.read("name"), 64, context),
      children: snapshotDenseArray(
        reader.read("children"),
        16,
        context,
        (child) => copyFrozenNode(child, context),
      ),
    }),
  );
}

test("closed builders and dense-array copies produce detached recursively frozen snapshots", () => {
  const source = {
    name: "root",
    children: [{ name: "leaf", children: [] }],
  };
  const snapshot = copyFrozenNode(source, createClosedSnapshotContext());

  assert.deepEqual(snapshot, source);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.children), true);
  assert.equal(Object.isFrozen(snapshot.children[0]), true);
  assert.equal(Object.isFrozen(snapshot.children[0]?.children), true);

  source.name = "mutated";
  source.children[0]!.name = "changed";
  source.children.push({ name: "new", children: [] });
  assert.deepEqual(snapshot, {
    name: "root",
    children: [{ name: "leaf", children: [] }],
  });
});
