import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalValidationError } from "../capabilities/validation.js";
import {
  escapeHtmlAttribute,
  generateArticle,
} from "./content.js";
import { stageArticleDraft } from "./draft.js";
import type { DraftAddPayload, WeChatClient } from "./client.js";

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function fixture(): { dir: string; cover: string } {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-render-safety-"));
  const cover = join(dir, "cover.png");
  writeFileSync(cover, png(900, 900));
  return { dir, cover };
}

function expectProblem(
  action: () => unknown,
  expected: { code: string; actual: string; field: "body" | "source" },
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LocalValidationError);
    assert.equal(error.problem.phase, "local");
    assert.equal(error.problem.code, expected.code);
    assert.equal(error.problem.field, expected.field);
    assert.equal(error.problem.actual, expected.actual);
    assert.ok(error.problem.expected);
    assert.equal(error.problem.unit, null);
    assert.match(error.message, /actual: .*; expected: /);
    assert.doesNotMatch(error.message, /Please report this|markedjs/);
    return true;
  });
}

test("WeChat rejects raw block, inline, and recursively nested HTML before asset reads", () => {
  const missingCover = join(tmpdir(), "publish-wechat-cover-must-not-be-read.png");
  const unsafe = [
    "<script>alert(1)</script>",
    "<STYLE>body{display:none}</STYLE>",
    "<link REL=stylesheet HREF=https://example.com/x.css>",
    "Text <IMG SRC=x OnErRoR=alert(1)> tail",
    "<SvG><a XLINK:HREF=javascript:alert(1)>x</a></SvG>",
    "<!-- caller comment -->",
    "<!DOCTYPE html>",
    "<?caller processing-instruction?>",
    "<![CDATA[<script>alert(1)</script>]]>",
    "# Consumed title <IMG SRC=x ONERROR=alert(1)>\n\nBody",
    "[label <svg ONLOAD=alert(1)>](https://example.com)",
    "![alt <img ONERROR=alert(1)>](local.png)",
    "- nested <iframe SRC=https://example.com></iframe>",
    "> quoted <details ONTOGGLE=alert(1)>x</details>",
    "| cell |\n| --- |\n| <video AUTOPLAY SRC=x></video> |",
    "**strong <object DATA=data:text/html,bad></object>**",
  ];

  for (const markdown of unsafe) {
    expectProblem(
      () => generateArticle(markdown, { title: "Title", cover: missingCover }),
      { code: "wechat_raw_html_unsupported", actual: "raw_html", field: "body" },
    );
  }
  expectProblem(
    () => generateArticle("# Consumed <IMG SRC=x ONERROR=alert(1)>\n\nBody", {
      cover: missingCover,
    }),
    { code: "wechat_raw_html_unsupported", actual: "raw_html", field: "body" },
  );
});

test("WeChat preserves entity/backslash-escaped HTML and HTML-looking code as inert text", () => {
  const { dir, cover } = fixture();
  try {
    const article = generateArticle(
      [
        "\\<IMG SRC=x ONERROR=alert(1)\\>",
        "",
        "&lt;script&gt;alert(1)&lt;/script&gt;",
        "",
        "`<svg onload=alert(1)>`",
        "",
        "```html",
        "<script>alert(1)</script>",
        "```",
        "",
        "    <iframe src=javascript:alert(1)></iframe>",
        "",
        "`[unsafe](javascript:alert(1))`",
        "",
        "[unused]: javascript:alert(1)",
      ].join("\n"),
      { title: "Title", cover },
    );

    assert.match(article.html, /&lt;IMG SRC=x ONERROR=alert\(1\)&gt;/);
    assert.match(article.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(article.html, /&lt;svg onload=alert\(1\)&gt;/);
    assert.match(article.html, /\[unsafe\]\(javascript:alert\(1\)\)/);
    assert.doesNotMatch(article.html, /<(?:script|svg|img|iframe)\b/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat rejects unsafe rendered link and image destinations after security canonicalization", () => {
  const missingCover = join(tmpdir(), "publish-wechat-url-cover-must-not-be-read.png");
  const unsafeLinks: Array<[string, string]> = [
    ["[x](JaVaScRiPt:alert(1))", "javascript"],
    ["[x](VBScript:msgbox(1))", "vbscript"],
    ["[x](data:text/html,bad)", "data"],
    ["[x](java&#x73;cript&#58;alert(1))", "javascript"],
    ["[x](javascript&colon;alert(1))", "javascript"],
    ["[x](jav%61script%3Aalert(1))", "javascript"],
    ["[x](%256a%2561%2576%2561%2573%2563%2572%2569%2570%2574%253aalert(1))", "javascript"],
    ["[x](%6A%61%76%61%73%63%72%69%70%74%3Aalert(1))", "javascript"],
    ["[x](https://example.com/%C2%85)", "control_character"],
    ["[x](https://example.com/%85)", "malformed_encoding"],
    ["[x](https://example.com/%)", "malformed_encoding"],
    ["[x](https://example.com/%GG)", "malformed_encoding"],
    ["[x](https://example.com/%E2%28%A1)", "malformed_encoding"],
    ["[x](https://example.com/%09)", "control_character"],
    ["[x](https://example.com/%0A)", "control_character"],
    ["[x](<java&Tab;script:alert(1)>)", "control_character"],
    ["[x](<java\u0085script:alert(1)>)", "control_character"],
    ["[x](<\thttps://example.com\t>)", "control_character"],
    ["[x](<\vhttps://example.com>)", "control_character"],
    ["[x](<https://example.com\u00a0>)", "surrounding_whitespace"],
    ["[x](<https%3A//example.com>)", "obfuscated_scheme"],
    ["[x](<https://example.com%2Fpath>)", "https:invalid"],
    ["[x](https:evil.example)", "https:invalid"],
    ["[x](<http:///evil.example>)", "http:invalid"],
    ["[x](<https:////evil.example>)", "https:invalid"],
    ["[x](<https://\\evil.example>)", "https:invalid"],
    ["[x](<https:\\evil.example>)", "https:invalid"],
    ["[x](<https://user@example.com/path>)", "credentials_unsupported"],
    ["[x](<https://:password@example.com/path>)", "credentials_unsupported"],
    ["[x](<https://@example.com/path>)", "credentials_unsupported"],
    ["[x](<java\\script:alert(1)>)", "malformed_scheme"],
    ["[x](<java\u200bscript:alert(1)>)", "malformed_scheme"],
    ["[x](//evil.example/path)", "scheme_relative"],
    ["[x](%2f%2fevil.example/path)", "scheme_relative"],
    ["[x](file:///tmp/private)", "file"],
    ["[x](<C:/images/link.png>)", "unsupported_scheme"],
    ["[reference][bad]\n\n[bad]: javascript:alert(1)", "javascript"],
    ["[collapsed][]\n\n[collapsed]: data:text/html,bad", "data"],
    ["| link |\n| --- |\n| [nested](javascript:alert(1)) |", "javascript"],
    ["<javascript:alert(1)>", "javascript"],
  ];
  for (const [markdown, actual] of unsafeLinks) {
    expectProblem(
      () => generateArticle(markdown, { title: "Title", cover: missingCover }),
      { code: "wechat_url_unsafe", actual, field: "body" },
    );
  }

  const unsafeImages: Array<[string, string]> = [
    ["![x](javascript:alert(1))", "javascript"],
    ["![x](data:image/png;base64,AAAA)", "data"],
    ["![x](vbscript:msgbox(1))", "vbscript"],
    ["![x](mailto:image@example.com)", "mailto"],
    ["![x](#fragment)", "fragment"],
    ["![x](//evil.example/x.png)", "scheme_relative"],
    [String.raw`![x](<\\\\server\share\x.png>)`, "scheme_relative"],
    ["![x](<http:///evil.example/x.png>)", "http:invalid"],
    ["![x](<https:////evil.example/x.png>)", "https:invalid"],
    ["![x](<https://\\evil.example/x.png>)", "https:invalid"],
    ["![x](<https://user@example.com/x.png>)", "credentials_unsupported"],
    ["![x](https://images.example.com/%E2%82.png)", "malformed_encoding"],
    ["![reference][bad]\n\n[bad]: java%73cript%3Ax", "javascript"],
    ["> ![nested](data:image/png;base64,AAAA)", "data"],
    ["![x](<\fhttps://example.com/x.png>)", "control_character"],
    ["![x](<\ufeff./local.png>)", "surrounding_whitespace"],
  ];
  for (const [markdown, actual] of unsafeImages) {
    expectProblem(
      () => generateArticle(markdown, { title: "Title", cover: missingCover }),
      { code: "wechat_url_unsafe", actual, field: "body" },
    );
  }

  const secretScheme = `SECRETSCHEME${"A".repeat(10_000)}`;
  assert.throws(
    () => generateArticle(`[x](${secretScheme}:payload)`, {
      title: "Title",
      cover: missingCover,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.actual, "unsupported_scheme");
      assert.ok(error.message.length < 400);
      assert.doesNotMatch(error.message, /SECRETSCHEME/);
      return true;
    },
  );
});

test("WeChat requires an absolute safe HTTP source URL before asset reads", () => {
  const missingCover = join(tmpdir(), "publish-wechat-source-cover-must-not-be-read.png");
  for (const [sourceUrl, actual] of [
    ["javascript:alert(1)", "javascript"],
    ["java%73cript%3Aalert(1)", "javascript"],
    ["https%3A//example.com/source", "obfuscated_scheme"],
    ["https:example.com/source", "https:invalid"],
    ["http:///evil.example/source", "http:invalid"],
    ["https:////evil.example/source", "https:invalid"],
    ["https://\\evil.example/source", "https:invalid"],
    ["https://user@example.com/source", "credentials_unsupported"],
    ["https://:password@example.com/source", "credentials_unsupported"],
    ["https://@example.com/source", "credentials_unsupported"],
    ["\thttps://example.com/source", "control_character"],
    ["https://example.com/source\u00a0", "surrounding_whitespace"],
    ["//evil.example/source", "scheme_relative"],
    ["mailto:editor@example.com", "mailto"],
    ["../relative-source", "relative"],
    ["C:/images/source.png", "unsupported_scheme"],
    ["https://example.com/%C2%85", "control_character"],
    ["https://example.com/%85", "malformed_encoding"],
    ["https://example.com/%", "malformed_encoding"],
    ["https://example.com/%09", "control_character"],
  ] as const) {
    expectProblem(
      () => generateArticle("Body", { title: "Title", cover: missingCover, sourceUrl }),
      { code: "wechat_source_url_unsafe", actual, field: "source" },
    );
  }
  expectProblem(
    () => generateArticle("Body", {
      title: "Title",
      cover: missingCover,
      frontmatter: { sourceUrl: "data:text/html,frontmatter" },
    }),
    { code: "wechat_source_url_unsafe", actual: "data", field: "source" },
  );
  const credential = `CREDENTIALSECRET${"Q".repeat(10_000)}`;
  assert.throws(
    () => generateArticle("Body", {
      title: "Title",
      cover: missingCover,
      sourceUrl: `https://operator:${credential}@`,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalValidationError);
      assert.equal(error.problem.actual, "credentials_unsupported");
      assert.ok(error.message.length < 400);
      assert.doesNotMatch(error.message, /CREDENTIALSECRET/);
      return true;
    },
  );
});

test("WeChat treats Windows drive-absolute image syntax as local but rejects it elsewhere", () => {
  const { dir, cover } = fixture();
  try {
    for (const href of ["C:/images/photo.png", "C:\\images\\photo.png"]) {
      assert.throws(
        () => generateArticle(`![local](<${href}>)`, { title: "Title", cover, baseDir: dir }),
        (error: unknown) => {
          assert.ok(error instanceof LocalValidationError);
          assert.equal(error.problem.code, "image_not_found");
          assert.equal(error.problem.field, "media");
          assert.equal(error.problem.actual, "missing");
          return true;
        },
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat preserves safe links, citations, source URLs, and escaped dynamic attributes", () => {
  const { dir, cover } = fixture();
  try {
    const encodedUnicode = "%E4%B8%AD%E6%96%87-%E2%80%99-%E2%80%93-%E2%80%94-%E2%82%AC";
    const inline = generateArticle(
      [
        "[external](<HTTPS://example.com/path?a=1&note=\"yes\">)",
        "[wechat](<https://mp.weixin.qq.com/s?id=1&note=\"wx\">)",
        "[relative](<../guide?a=1&note=\"local\">)",
        "[fragment](#part)",
        "[mail](<mailto:editor@example.com?subject=Hi&body=\"quoted\">)",
        "[deep](https://example.com/%252525252525252525safe)",
        "[ipv6](<http://[2001:db8::1]:8080/path>)",
        "[port](https://example.com:8443/path)",
        `[unicode](https://example.com/${encodedUnicode})`,
        "[percent relative](<./100%25-complete>)",
        "[nested percent relative](<./100%2525-complete>)",
        "![remote](<http://images.example.com/a.png?x=1&note=\"img\">)",
        `![unicode image](https://images.example.com/${encodedUnicode}.png)`,
      ].join("\n\n"),
      {
        title: "Title",
        cover,
        keepLinks: true,
        sourceUrl: `HTTPS://[2001:db8::1]:8443/${encodedUnicode}?x=1`,
      },
    );
    assert.equal(inline.sourceUrl, `HTTPS://[2001:db8::1]:8443/${encodedUnicode}?x=1`);
    for (const expected of [
      'href="HTTPS://example.com/path?a=1&amp;note=&quot;yes&quot;"',
      'href="https://mp.weixin.qq.com/s?id=1&amp;note=&quot;wx&quot;"',
      'href="../guide?a=1&amp;note=&quot;local&quot;"',
      'href="#part"',
      'href="mailto:editor@example.com?subject=Hi&amp;body=&quot;quoted&quot;"',
      'href="https://example.com/%252525252525252525safe"',
      'href="http://[2001:db8::1]:8080/path"',
      'href="https://example.com:8443/path"',
      `href="https://example.com/${encodedUnicode}"`,
      'href="./100%25-complete"',
      'href="./100%2525-complete"',
      'src="http://images.example.com/a.png?x=1&amp;note=&quot;img&quot;"',
      `src="https://images.example.com/${encodedUnicode}.png"`,
    ]) assert.equal(inline.html.includes(expected), true, expected);
    assert.ok(inline.warnings.some((warning) => /remote image/.test(warning)));

    const cited = generateArticle(
      `[O'Brien "R&D" & partners](https://example.com/path?a=1&b=2) and ` +
        "[wechat](https://mp.weixin.qq.com/s?id=1&b=2)",
      { title: "Title", cover },
    );
    assert.match(cited.html, /O&#39;Brien &quot;R&amp;D&quot; &amp; partners<sup[^>]*>\[1\]<\/sup>/);
    assert.match(cited.html, /References/);
    assert.match(
      cited.html,
      /<li[^>]*>O&#39;Brien &quot;R&amp;D&quot; &amp; partners — https:\/\/example\.com\/path\?a=1&amp;b=2<\/li>/,
    );
    assert.doesNotMatch(cited.html, /&amp;#39;|&amp;quot;|&amp;amp;|&amp;amp;amp;/);
    assert.match(cited.html, /href="https:\/\/mp\.weixin\.qq\.com\/s\?id=1&amp;b=2"/);
    assert.equal(cited.linkFlags.some((flag) => flag.url.includes("example.com")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WeChat keeps exact local image identity and safely rewrites escaped attributes in caller order", async () => {
  const { dir, cover } = fixture();
  try {
    const sources = [
      './a&b.png',
      './a&amp;b.png',
      './quote"file.png',
      "./space file.png",
      "./100%25-complete.png",
    ];
    for (const source of sources) writeFileSync(join(dir, source.slice(2)), png(640, 480));

    const article = generateArticle(
      [
        '`src="./a&b.png" must remain inspection text`',
        "![first <&>](<./a&b.png>)",
        "![entity](<./a&amp;b.png>)",
        "![quoted](<./quote\"file.png>)",
        "![spaced](<./space file.png>)",
        "![percent](<./100%25-complete.png>)",
        "![first again](<./a&b.png>)",
      ].join("\n\n"),
      { title: "Title", cover, baseDir: dir },
    );

    assert.deepEqual(article.bodyImages.map((image) => image.src), sources);
    assert.deepEqual(article.bodyImages.map((image) => image.htmlSrc), [
      "./a&amp;b.png",
      "./a&amp;amp;b.png",
      "./quote&quot;file.png",
      "./space file.png",
      "./100%25-complete.png",
    ]);
    assert.deepEqual(article.bodyImages.map((image) => image.path),
      sources.map((source) => join(dir, source.slice(2))));
    assert.match(article.html, /alt="first &lt;&amp;&gt;"/);
    assert.equal(article.html.match(/<img src="\.\/a&amp;b\.png"/g)?.length, 2);
    assert.equal(article.html.split('src="./a&amp;amp;b.png"').length - 1, 1);
    assert.equal(article.html.split('src="./quote&quot;file.png"').length - 1, 1);
    assert.equal(article.html.split('src="./space file.png"').length - 1, 1);
    assert.equal(article.html.split('src="./100%25-complete.png"').length - 1, 1);
    assert.doesNotMatch(article.html, /src="\.\/quote"file\.png"/);

    const calls: string[] = [];
    const uploadedUrls = [
      'https://mmbiz.qpic.cn/one?x=1&label="first"',
      "https://mmbiz.qpic.cn/two?x=2&label=entity",
      "https://mmbiz.qpic.cn/three?x=3&label=quoted",
      "https://mmbiz.qpic.cn/four?x=4&label=spaced",
      "https://mmbiz.qpic.cn/five?x=5&label=percent",
    ];
    let payload: DraftAddPayload | undefined;
    const client: WeChatClient = {
      async ensureToken() {
        calls.push("token");
        return "token";
      },
      async uploadCover(localPath) {
        calls.push(`cover:${localPath}`);
        return "thumb";
      },
      async uploadBodyImage(localPath) {
        const index = calls.filter((call) => call.startsWith("body:")).length;
        calls.push(`body:${localPath}`);
        return uploadedUrls[index];
      },
      async addDraft(value) {
        calls.push("draft");
        payload = value;
        return "draft-id";
      },
      async checkAccess() {
        throw new Error("not used");
      },
      async close() {},
    };

    const result = await stageArticleDraft(client, article);
    assert.deepEqual(calls, [
      "token",
      `cover:${cover}`,
      ...article.bodyImages.map((image) => `body:${image.path}`),
      "draft",
    ]);
    assert.deepEqual(result.uploadedImages, sources.map((local, index) => ({
      local,
      url: uploadedUrls[index],
    })));
    const content = payload?.articles[0]?.content ?? "";
    assert.doesNotMatch(content, /<img src="\.\/a&amp;b\.png"/);
    assert.doesNotMatch(content, /<img src="\.\/a&amp;amp;b\.png"/);
    assert.doesNotMatch(content, /<img src="\.\/quote&quot;file\.png"/);
    assert.doesNotMatch(content, /<img src="\.\/space file\.png"/);
    assert.doesNotMatch(content, /<img src="\.\/100%25-complete\.png"/);
    assert.equal(content.split(`src="${escapeHtmlAttribute(uploadedUrls[0])}"`).length - 1, 2);
    assert.equal(content.split(`src="${escapeHtmlAttribute(uploadedUrls[1])}"`).length - 1, 1);
    assert.equal(content.split(`src="${escapeHtmlAttribute(uploadedUrls[2])}"`).length - 1, 1);
    assert.equal(content.split(`src="${escapeHtmlAttribute(uploadedUrls[3])}"`).length - 1, 1);
    assert.equal(content.split(`src="${escapeHtmlAttribute(uploadedUrls[4])}"`).length - 1, 1);
    assert.doesNotMatch(content, /src="https:\/\/mmbiz\.qpic\.cn\/one\?x=1&label="first"/);
    assert.match(content, /<code[^>]*>src="\.\/a&amp;b\.png" must remain inspection text<\/code>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
