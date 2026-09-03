import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Marked } from "marked";
import { splitLeadingFrontmatter } from "../commands/contentInput.js";
import {
  X_CODE_INFO_MAX_CODE_POINTS,
  X_CODE_PREVIEW_MAX_CODE_POINTS,
  generateContent,
  renderForInspection,
  type CodeBlockFidelityFlag,
} from "./content.js";
import { LocalValidationError, countXWeightedLength } from "../capabilities/validation.js";

const placeholder = (index: number): string => `[code block #${index} → screenshot]`;
const tildeFence = String.fromCharCode(126).repeat(3);
const longTildeFence = String.fromCharCode(126).repeat(4);

function codeFidelity(value: Awaited<ReturnType<typeof generateContent>>): CodeBlockFidelityFlag[] {
  return value.fidelityFlags.filter(
    (flag): flag is CodeBlockFidelityFlag => flag.kind === "code_block",
  );
}

function withoutThreadNumbers(value: Awaited<ReturnType<typeof generateContent>>): string {
  return (value.thread ?? [])
    .map((post) => post.text.replace(/ \d+\/\d+$/, ""))
    .join("");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("X code-block transforms emit one exact source-ordered fidelity fact per placeholder", async () => {
  const lines = [
    "# Release",
    "",
    "Intro",
    "```ts title=demo",
    "const x = 1;",
    "```",
    "",
    "Between",
    `   ${tildeFence} py linenos`,
    "print(1)",
    `  ${longTildeFence}   `,
    "",
    "```",
    "```",
    "",
    "Tail",
  ];
  const generated = await generateContent(lines.join("\n"), { format: "tweet" });
  const flags = codeFidelity(generated);

  assert.equal(generated.tweet?.text, [
    "Intro",
    placeholder(1),
    "",
    "Between",
    placeholder(2),
    "",
    placeholder(3),
    "",
    "Tail",
  ].join("\n"));
  assert.deepEqual(
    flags.map((flag) => ({
      index: flag.index,
      placeholder: flag.placeholder,
      lines: [flag.sourceStartLine, flag.sourceEndLine, flag.sourceLineCount],
      fence: flag.fence,
      closure: flag.closure,
      info: flag.infoString,
      preview: flag.preview,
      digest: flag.normalizedSourceSha256,
    })),
    [
      {
        index: 1,
        placeholder: placeholder(1),
        lines: [4, 6, 3],
        fence: "backtick",
        closure: "explicit",
        info: "ts title=demo",
        preview: "const x = 1;",
        digest: sha256(lines.slice(3, 6).join("\n")),
      },
      {
        index: 2,
        placeholder: placeholder(2),
        lines: [9, 11, 3],
        fence: "tilde",
        closure: "explicit",
        info: "py linenos",
        preview: "print(1)",
        digest: sha256(lines.slice(8, 11).join("\n")),
      },
      {
        index: 3,
        placeholder: placeholder(3),
        lines: [13, 14, 2],
        fence: "backtick",
        closure: "explicit",
        info: null,
        preview: "",
        digest: sha256(lines.slice(12, 14).join("\n")),
      },
    ],
  );
  assert.equal(generated.codeFlags.length, flags.length);
  assert.equal(generated.warnings.filter((warning) => /\(code_block\)/.test(warning)).length, flags.length);
  assert.equal(Array.from(generated.tweet?.text.matchAll(/\[code block #[0-9]+ → screenshot\]/g) ?? []).length, flags.length);
  assert.equal(countXWeightedLength(placeholder(1)), 29);

  const rendered = renderForInspection(generated);
  for (const flag of flags) {
    assert.match(rendered, new RegExp(`lines ${flag.sourceStartLine}-${flag.sourceEndLine}`));
    assert.match(rendered, new RegExp(flag.normalizedSourceSha256));
    assert.match(rendered, new RegExp(flag.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("X fence boundaries follow parser-confirmed CommonMark shapes without false closes", async () => {
  const source = [
    "Before",
    "````javascript extra",
    "alpha",
    "```",
    tildeFence,
    "```` trailing-content",
    "omega",
    "`````   ",
    "After",
  ].join("\n");
  const generated = await generateContent(source, { format: "tweet" });
  const [flag] = codeFidelity(generated);

  assert.equal(generated.codeFlags.length, 1);
  assert.equal(flag?.sourceStartLine, 2);
  assert.equal(flag?.sourceEndLine, 8);
  assert.equal(flag?.sourceLineCount, 7);
  assert.equal(flag?.closure, "explicit");
  assert.equal(flag?.infoString, "javascript extra");
  assert.equal(generated.tweet?.text, `Before\n${placeholder(1)}\nAfter`);

  for (const [open, mixedClose, trueClose] of [
    ["```", `\`\`\`${tildeFence}`, "```"],
    [tildeFence, `${tildeFence}\`\`\``, tildeFence],
  ]) {
    const explicitLines = [
      "Before",
      open,
      "payload",
      mixedClose,
      "TRAILING_PROSE_CANARY",
      trueClose,
      "After",
    ];
    const explicit = await generateContent(explicitLines.join("\n"), { format: "tweet" });
    const [explicitFlag] = codeFidelity(explicit);
    assert.equal(explicit.tweet?.text, `Before\n${placeholder(1)}\nAfter`);
    assert.equal(explicitFlag?.closure, "explicit");
    assert.equal(explicitFlag?.sourceStartLine, 2);
    assert.equal(explicitFlag?.sourceEndLine, 6);
    assert.equal(
      explicitFlag?.normalizedSourceSha256,
      sha256(explicitLines.slice(1, 6).join("\n")),
    );

    const eofLines = ["Before", open, "payload", mixedClose, "TRAILING_PROSE_CANARY"];
    const eof = await generateContent(eofLines.join("\n"), { format: "tweet" });
    const [eofFlag] = codeFidelity(eof);
    assert.equal(eof.tweet?.text, `Before\n${placeholder(1)}`);
    assert.equal(eofFlag?.closure, "end_of_input");
    assert.equal(eofFlag?.sourceEndLine, 5);
    assert.equal(eofFlag?.normalizedSourceSha256, sha256(eofLines.slice(1).join("\n")));
    assert.doesNotMatch(eof.tweet?.text ?? "", /TRAILING_PROSE_CANARY/);
  }
});

test("X accepts spaces and tabs after strict closers without hiding following source", async () => {
  for (const marker of ["```", tildeFence]) {
    for (const trailingWhitespace of ["\t", " \t  \t"]) {
      const sourceLines = [
        "Before",
        `${marker}js`,
        "run()",
        `${marker}${trailingWhitespace}`,
        "After",
        `${marker}txt`,
        "second()",
        marker,
        "Tail",
      ];
      const generated = await generateContent(sourceLines.join("\n"), { format: "tweet" });
      const flags = codeFidelity(generated);
      assert.equal(
        generated.tweet?.text,
        `Before\n${placeholder(1)}\nAfter\n${placeholder(2)}\nTail`,
      );
      assert.deepEqual(
        flags.map((flag) => ({
          lines: [flag.sourceStartLine, flag.sourceEndLine],
          closure: flag.closure,
          digest: flag.normalizedSourceSha256,
        })),
        [
          {
            lines: [2, 4],
            closure: "explicit",
            digest: sha256(sourceLines.slice(1, 4).join("\n")),
          },
          {
            lines: [6, 8],
            closure: "explicit",
            digest: sha256(sourceLines.slice(5, 8).join("\n")),
          },
        ],
      );
    }

    const notACloser = ["Before", `${marker}js`, "run()", `${marker}\tCANARY`, "After"];
    const eof = await generateContent(notACloser.join("\n"), { format: "tweet" });
    const [eofFlag] = codeFidelity(eof);
    assert.equal(eof.tweet?.text, `Before\n${placeholder(1)}`);
    assert.equal(eofFlag?.closure, "end_of_input");
    assert.equal(eofFlag?.sourceEndLine, 5);
    assert.equal(eofFlag?.normalizedSourceSha256, sha256(notACloser.slice(1).join("\n")));
  }

  for (const marker of ["```", tildeFence]) {
    await assert.rejects(
      generateContent(
        [
          "Before",
          `${marker}js`,
          "run()",
          `${marker}\t`,
          "> quote",
          "> ```py",
          "> nested()",
          "> ```",
        ].join("\n"),
        { format: "thread" },
      ),
      (error: unknown) => {
        assert.ok(error instanceof LocalValidationError);
        assert.equal(error.problem.code, "x_nested_code_block_mapping_unsupported");
        return true;
      },
    );
  }
});

test("X nested-looking fences inside strict mixed-marker spans stay outer code", async () => {
  for (const [open, mixedClose, trueClose] of [
    ["```js", `\`\`\`${tildeFence}`, "```"],
    [`${tildeFence}js`, `${tildeFence}\`\`\``, tildeFence],
  ]) {
    const innerFence = open.startsWith("`") ? tildeFence : "```";
    const nestedShapes = [
      [`> ${innerFence}py`, "> innerQuote()", `> ${innerFence}`],
      ["- item", "", `  ${innerFence}py`, "  innerList()", `  ${innerFence}`],
    ];
    for (const nestedLines of nestedShapes) {
      for (const explicit of [false, true]) {
        const sourceLines = [
          "Before",
          open,
          "outerPayload()",
          mixedClose,
          ...nestedLines,
          ...(explicit ? [trueClose, "After"] : []),
        ];
        const generated = await generateContent(sourceLines.join("\n"), { format: "tweet" });
        const [flag] = codeFidelity(generated);
        assert.equal(
          generated.tweet?.text,
          explicit ? `Before\n${placeholder(1)}\nAfter` : `Before\n${placeholder(1)}`,
        );
        assert.equal(flag?.closure, explicit ? "explicit" : "end_of_input");
        assert.equal(flag?.sourceEndLine, explicit ? sourceLines.length - 1 : sourceLines.length);
        assert.equal(
          flag?.normalizedSourceSha256,
          sha256(sourceLines.slice(1, explicit ? -1 : undefined).join("\n")),
        );
        assert.doesNotMatch(generated.tweet?.text ?? "", /innerQuote|innerList/);
      }
    }
  }
});

test("X strict mixed-marker boundaries do not hide later top-level fences", async () => {
  for (const [first, mixed, second] of [
    ["```", `\`\`\`${tildeFence}`, tildeFence],
    [tildeFence, `${tildeFence}\`\`\``, "```"],
  ]) {
    const sourceLines = [
      "A",
      `${first}js`,
      "first()",
      mixed,
      "inside()",
      first,
      "Between",
      `${second}py`,
      "second()",
      second,
      "Tail",
    ];
    const generated = await generateContent(sourceLines.join("\n"), { format: "tweet" });
    assert.equal(
      generated.tweet?.text,
      `A\n${placeholder(1)}\nBetween\n${placeholder(2)}\nTail`,
    );
    assert.deepEqual(
      codeFidelity(generated).map((flag) => ({
        lines: [flag.sourceStartLine, flag.sourceEndLine],
        closure: flag.closure,
      })),
      [
        { lines: [2, 6], closure: "explicit" },
        { lines: [8, 10], closure: "explicit" },
      ],
    );
  }
});

test("X ignores unrelated Marked EOF normalization while retaining adjacent exact fence mapping", async () => {
  const ordinarySources = [
    "> - item\ncontinuation",
    "> -\ncontinuation",
    ">-\nx",
    "> *\nx",
    "> 1.\nx",
  ];
  for (const ordinary of ordinarySources) {
    const ordinaryGenerated = await generateContent(ordinary, { format: "thread" });
    assert.equal(withoutThreadNumbers(ordinaryGenerated), ordinary);
    assert.deepEqual(codeFidelity(ordinaryGenerated), []);

    const adjacent = `${ordinary}\n\n\`\`\`js\nrun()\n\`\`\`\nAfter`;
    const adjacentGenerated = await generateContent(adjacent, { format: "thread" });
    assert.equal(
      withoutThreadNumbers(adjacentGenerated),
      `${ordinary}\n\n${placeholder(1)}\nAfter`,
    );
    assert.deepEqual(
      codeFidelity(adjacentGenerated).map((flag) => [flag.sourceStartLine, flag.sourceEndLine]),
      [[4, 6]],
    );
  }
});

test("X maps fence offsets across parser-consumed duplicate reference definitions", async () => {
  const sourceLines = [
    "[x]: /first",
    "[x]: /duplicate-consumed-without-token",
    "",
    "```js",
    "first()",
    "```",
    "Between",
    "[y]: /second",
    "[y]: /another-duplicate-consumed-without-token",
    "",
    "```ts",
    "second()",
    "```",
    "Tail",
  ];
  const generated = await generateContent(sourceLines.join("\n"), { format: "thread" });
  assert.deepEqual(
    codeFidelity(generated).map((flag) => ({
      lines: [flag.sourceStartLine, flag.sourceEndLine],
      digest: flag.normalizedSourceSha256,
    })),
    [
      { lines: [4, 6], digest: sha256(sourceLines.slice(3, 6).join("\n")) },
      { lines: [11, 13], digest: sha256(sourceLines.slice(10, 13).join("\n")) },
    ],
  );
  assert.equal(withoutThreadNumbers(generated).includes(placeholder(1)), true);
  assert.equal(withoutThreadNumbers(generated).includes(placeholder(2)), true);
  assert.match(withoutThreadNumbers(generated), /Between/);
  assert.match(withoutThreadNumbers(generated), /Tail/);
});

test("X leaves HTML-contained fence text literal and maps a later top-level fence", async () => {
  const sourceLines = [
    "<div>",
    "```js",
    "htmlLiteral()",
    "```",
    "</div>",
    "",
    "```ts",
    "topLevel()",
    "```",
    "Tail",
  ];
  const generated = await generateContent(sourceLines.join("\n"), { format: "thread" });
  const [flag] = codeFidelity(generated);
  assert.equal(codeFidelity(generated).length, 1);
  assert.equal(flag?.sourceStartLine, 7);
  assert.equal(flag?.sourceEndLine, 9);
  assert.equal(flag?.normalizedSourceSha256, sha256(sourceLines.slice(6, 9).join("\n")));
  assert.match(withoutThreadNumbers(generated), /htmlLiteral\(\)/);
  assert.equal(withoutThreadNumbers(generated).includes(placeholder(1)), true);
  assert.match(withoutThreadNumbers(generated), /Tail/);
});

test("X keeps ordinary, indented, short, escaped, and invalid-info fence-like prose literal", async () => {
  const cases = [
    "inline ```js marker",
    "\\```js escaped opener",
    "`` short marker",
    "    ```js\n    indented\n    ```",
    "\t```js\n\ttab-indented\n\t```",
    "```bad`info\npayload without a later valid opener",
  ];

  for (const source of cases) {
    const generated = await generateContent(source, { format: "thread" });
    assert.equal(generated.codeFlags.length, 0, source);
    assert.equal(codeFidelity(generated).length, 0, source);
    assert.equal(withoutThreadNumbers(generated), source.trim(), source);
  }
});

test("X mapped top-level fences do not reclassify later indented code as nested", async () => {
  for (const ending of ["    ``` ", "    ```\n", "    ``` \n"]) {
    const source = [
      "- item",
      "```js",
      "top",
      "```",
      "    ```js",
      "    indented",
      ending,
    ].join("\n");
    const generated = await generateContent(source, { format: "thread" });
    assert.equal(codeFidelity(generated).length, 1);
    assert.equal(generated.codeFlags.length, 1);
    assert.equal(
      withoutThreadNumbers(generated),
      `- item\n${placeholder(1)}\n    \`\`\`js\n    indented\n    \`\`\``,
    );
  }
});

test("X fence classification performs one root lexer pass for adversarial candidates", async (t) => {
  const lexer = t.mock.method(Marked.prototype, "lexer");
  const fence = "```";
  const htmlCandidates = Array.from(
    { length: 3_000 },
    (_, index) => `  ${fence}${index % 2 === 0 ? "" : "js"}\n  candidate-${index}`,
  ).join("\n");
  const source = `<div>\n${htmlCandidates}\n</div>\nVisible`;

  const generated = await generateContent(source, { format: "thread" });
  assert.equal(codeFidelity(generated).length, 0);
  assert.equal(lexer.mock.callCount(), 1);

  const nestedCandidates = Array.from(
    { length: 1_500 },
    (_, index) => `  ${fence}js\n  nested-${index}\n  ${fence}`,
  ).join("\n");
  await assert.rejects(
    generateContent(`- item\n\n${nestedCandidates}`, { format: "thread" }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_nested_code_block_mapping_unsupported");
      return true;
    },
  );
  // One document-level lexer call per generation regardless of whether there
  // are one or 3,000 unconfirmed/nested fence-like source lines.
  assert.equal(lexer.mock.callCount(), 2);
});

test("X parser and source-boundary failures stay bounded and terminal-safe", async (t) => {
  const parserSecret = "PARSER_CANARY_UNBOUNDED_DETAIL";
  t.mock.method(Marked.prototype, "lexer", () => {
    throw new Error(parserSecret);
  });
  await assert.rejects(
    generateContent("Before\n```js\nrun()\n```", { format: "tweet" }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_code_block_parse_failed");
      assert.equal(error.problem.actual, "parser_failed");
      assert.doesNotMatch(error.message, new RegExp(parserSecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("X rejects parser-confirmed nested quote/list fences before producing transport text", async () => {
  for (const source of [
    "> quoted\n> ```js\n> secret()\n> ```",
    "- item\n\n  ```js\n  secret()\n  ```",
    "> quoted\n> ```py\n> secret()\n> ```\nBefore\n```js\nouter()\n```",
    "Before\n```js\nouter()\n```\n> quoted\n> ```py\n> secret()\n> ```",
  ]) {
    await assert.rejects(
      generateContent(source, { format: "thread" }),
      (error: unknown) => {
        assert.ok(error instanceof LocalValidationError);
        assert.equal(error.problem.phase, "local");
        assert.equal(error.problem.code, "x_nested_code_block_mapping_unsupported");
        assert.equal(error.problem.actual, "nested_fenced_code");
        assert.doesNotMatch(error.message, /secret\(\)/);
        return true;
      },
    );
  }
});

test("X reports a valid unclosed fence through the physical end of input", async () => {
  const source = "Before\r\n```js\r\nrun()\r\n";
  const generated = await generateContent(source, { format: "tweet", sourceLineOffset: 7 });
  const [flag] = codeFidelity(generated);

  assert.equal(generated.tweet?.text, `Before\n${placeholder(1)}`);
  assert.equal(flag?.closure, "end_of_input");
  assert.equal(flag?.sourceStartLine, 9);
  assert.equal(flag?.sourceEndLine, 10);
  assert.equal(flag?.sourceLineCount, 2);
  assert.equal(flag?.normalizedSourceSha256, sha256("```js\nrun()"));

  for (const marker of ["```", tildeFence]) {
    const sourceWithoutTerminalLf = `Before\n${marker}`;
    const openerOnly = await generateContent(sourceWithoutTerminalLf, { format: "tweet" });
    const [openerOnlyFlag] = codeFidelity(openerOnly);
    assert.equal(openerOnly.tweet?.text, `Before\n${placeholder(1)}`);
    assert.equal(openerOnlyFlag?.closure, "end_of_input");
    assert.equal(openerOnlyFlag?.sourceStartLine, 2);
    assert.equal(openerOnlyFlag?.sourceEndLine, 2);
    assert.equal(openerOnlyFlag?.sourceLineCount, 1);
    assert.equal(openerOnlyFlag?.preview, "");
    assert.equal(openerOnlyFlag?.normalizedSourceSha256, sha256(marker));
  }
});

test("X bounds and terminal-sanitizes code identification while retaining a complete digest", async () => {
  const unsafe = "\u001b\u061c\u2028\u2029\u202e\u2061\u2062\u2063\u2064";
  const longInfo = `lang-${unsafe}-${"i".repeat(10_000)}-INFO_TAIL`;
  const rawPreview = `prefix-${unsafe}-${"x".repeat(10_000)}-PREVIEW_TAIL`;
  const segment = `${tildeFence}${longInfo}\n${rawPreview}\n${tildeFence}`;
  const generated = await generateContent(`Visible\n${segment}`, { format: "tweet", long: true });
  const [flag] = codeFidelity(generated);
  const rendered = renderForInspection(generated);

  assert.ok(flag);
  assert.equal(flag.infoStringTruncated, true);
  assert.equal(flag.previewTruncated, true);
  assert.ok(Array.from(flag.infoString ?? "").length <= X_CODE_INFO_MAX_CODE_POINTS);
  assert.ok(Array.from(flag.preview).length <= X_CODE_PREVIEW_MAX_CODE_POINTS);
  const unsafeCategories = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  assert.doesNotMatch(JSON.stringify(flag), unsafeCategories);
  assert.doesNotMatch(JSON.stringify(generated.codeFlags), unsafeCategories);
  for (const character of Array.from(unsafe)) {
    assert.equal(rendered.includes(character), false);
  }
  for (const escaped of ["1b", "61c", "2028", "2029", "202e", "2061", "2062", "2063", "2064"]) {
    assert.match(flag.infoString ?? "", new RegExp(`\\\\u\\{${escaped}\\}`));
    assert.match(flag.preview, new RegExp(`\\\\u\\{${escaped}\\}`));
  }
  assert.doesNotMatch(rendered, /INFO_TAIL|PREVIEW_TAIL/);
  assert.ok(rendered.length < 2_000);
  assert.equal(flag.normalizedSourceSha256, sha256(segment));
});

test("X excludes removed-code URLs from link flags while keeping outside links", async () => {
  const inside = "https://inside.invalid/private-canary";
  const outside = "https://outside.example/resource";
  const generated = await generateContent(
    `# Link check\n\nVisible ${outside}\n\n\`\`\`txt\n${inside}\n\`\`\``,
    { format: "tweet" },
  );

  assert.deepEqual(generated.linkFlags.map((flag) => flag.url), [outside]);
  const rendered = renderForInspection(generated);
  const linkSection = rendered.split("⚠ LINKS (placement matters for reach):")[1]?.split("⚠ WARNINGS:")[0] ?? "";
  assert.doesNotMatch(linkSection, /inside\.invalid|private-canary/);
});

test("X thread packing keeps every numbered placeholder atomic and reconstructs exact prose", async () => {
  const fences = Array.from(
    { length: 12 },
    (_, index) => `\`\`\`txt\nvalue-${index + 1}\n\`\`\``,
  );
  const source = `${"a".repeat(250)}\n${fences.join("\n")}`;
  const generated = await generateContent(source, { format: "thread" });
  const expected = `${"a".repeat(250)}\n${fences.map((_, index) => placeholder(index + 1)).join("\n")}`;

  assert.equal(withoutThreadNumbers(generated), expected);
  assert.equal(codeFidelity(generated).length, 12);
  for (let index = 1; index <= 12; index += 1) {
    const exact = placeholder(index);
    assert.equal((generated.thread ?? []).filter((post) => post.text.includes(exact)).length, 1);
  }
  assert.ok((generated.thread ?? []).every((post) => post.chars <= 280));
});

test("X skips the optional voice rewrite when exact code placeholders are present", async () => {
  let voiceCalls = 0;
  const generated = await generateContent("Before\n```js\nrun()\n```\nAfter", {
    format: "tweet",
    voice: {
      model: "test-model",
      client: {
        async generate() {
          voiceCalls += 1;
          return "rewritten without its placeholder";
        },
      } as never,
    },
  });

  assert.equal(voiceCalls, 0);
  assert.equal(generated.tweet?.text, `Before\n${placeholder(1)}\nAfter`);

  const invented = await generateContent("Canonical prose", {
    format: "tweet",
    voice: {
      model: "test-model",
      client: {
        async generate() {
          return `Rewritten with invented ${placeholder(8)}`;
        },
      } as never,
    },
  });
  assert.equal(invented.tweet?.text, "Canonical prose");
  assert.deepEqual(invented.fidelityFlags, []);
});

test("X maps code fidelity to original file/stdin lines across BOM and line endings", async () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (const bom of ["", "\ufeff"]) {
      const source =
        `${bom}---${newline}private: ignored${newline}---${newline}` +
        `Visible${newline}\`\`\`js${newline}run()${newline}\`\`\`${newline}`;
      const split = splitLeadingFrontmatter(source, "input.md", {
        policy: "mapping-only",
        preserveBodyLineEndings: true,
      });
      const generated = await generateContent(split.body, {
        format: "tweet",
        sourceLineOffset: split.bodyLineOffset,
      });
      const [flag] = codeFidelity(generated);
      assert.equal(split.bodyLineOffset, 3);
      assert.equal(flag?.sourceStartLine, 5);
      assert.equal(flag?.sourceEndLine, 7);
      assert.equal(flag?.normalizedSourceSha256, sha256("```js\nrun()\n```"));
      assert.doesNotMatch(JSON.stringify(generated), /private: ignored/);
    }
  }

  const inline = await generateContent("\ufeffLiteral BOM\r\n```js\r\nrun()\r\n```", {
    format: "tweet",
  });
  assert.equal(codeFidelity(inline)[0]?.sourceStartLine, 2);
  assert.match(inline.tweet?.text ?? "", /^Literal BOM/);
});

test("X rejects reserved placeholder collisions and includes bounded code evidence on overflow", async () => {
  await assert.rejects(
    generateContent(`Literal ${placeholder(99)}`, { format: "tweet" }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_code_block_placeholder_collision");
      return true;
    },
  );

  const omittedTitle = await generateContent(`# ${placeholder(7)}\nVisible`, { format: "tweet" });
  assert.equal(omittedTitle.tweet?.text, "Visible");
  const insideCode = await generateContent(
    `Visible\n\`\`\`txt\n${placeholder(7)}\n\`\`\``,
    { format: "tweet" },
  );
  assert.equal(insideCode.tweet?.text, `Visible\n${placeholder(1)}`);

  await assert.rejects(
    generateContent(`${"a".repeat(281)}\n\`\`\`secret-info\n${"x".repeat(500)}SECRET_BODY_TAIL\n\`\`\``, {
      format: "tweet",
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.code, "x_text_too_long");
      assert.match(error.message, /Source fidelity evidence/);
      assert.match(error.message, /Source fidelity evidence for transformations/);
      assert.doesNotMatch(error.message, /Source fidelity evidence for omitted lines/);
      assert.match(error.message, /\[code_block\].*LF-normalized-source-sha256=/s);
      assert.doesNotMatch(error.message, /SECRET_BODY_TAIL/);
      assert.ok(error.message.length < 2_000);
      return true;
    },
  );
});

test("X Article parsing keeps the pre-existing Article code path out of code fidelity scope", async () => {
  const generated = await generateContent("# Article\n\n```js\nrun()\n```", { format: "article" });
  assert.deepEqual(generated.fidelityFlags, []);
  assert.equal(generated.article?.blocks.some((block) => block.kind === "code"), true);
});
