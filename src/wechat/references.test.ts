import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalValidationError } from "../capabilities/validation.js";
import { generateArticle, type GenerateArticleOptions } from "./content.js";

function render(markdown: string, options: Partial<GenerateArticleOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-references-"));
  const cover = join(dir, "cover.png");
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(900, 16);
  header.writeUInt32BE(900, 20);
  writeFileSync(cover, header);
  try {
    return generateArticle(markdown, { title: "Title", cover, ...options });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compactSection(html: string, withGeneratedCitations = false): string {
  const sections = html.match(/<section\b[^>]*>[\s\S]*?<\/section>/g) ?? [];
  assert.equal(sections.length, withGeneratedCitations ? 2 : 1,
    "one authored bibliography, plus a footer only for links outside it");
  assert.match(sections[0], /<section\b[^>]*style="[^"]*border-top:/);
  assert.match(sections[0], /<(?:h[1-6]|p)\b[^>]*style="[^"]*font-size:14px/);
  assert.doesNotMatch(withGeneratedCitations ? sections[0] : html, /<sup\b/);
  return sections[0];
}

function expectLocalError(markdown: string, code: string, keepLinks = false): void {
  const dir = mkdtempSync(join(tmpdir(), "publish-wechat-references-no-read-"));
  try {
    assert.throws(
      () => generateArticle(markdown, {
        title: "Title",
        cover: join(dir, "missing-cover.png"),
        keepLinks,
      }),
      (error: unknown) => {
        assert.ok(error instanceof LocalValidationError);
        assert.equal(error.problem.phase, "local");
        assert.equal(error.problem.code, code);
        assert.equal(error.problem.field, "body");
        assert.doesNotMatch(error.message, /Please report this|markedjs|ENOENT/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("WeChat preserves nine authored entries with twelve links and trailing metadata", () => {
  const entries = Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    const primary = `[Source ${n}](https://example.com/source-${n})`;
    const supporting = n <= 3
      ? ` and [Supporting ${n}](https://example.com/supporting-${n})`
      : "";
    return `【${n}】 Author ${n}. ${primary}${supporting}. (2026).`;
  });
  const body = "Opening paragraph with **unchanged emphasis**.";
  const metadata = "Created: 2026-09-07 · editor@example.com";
  const article = render([body, "## 参考文献", ...entries, metadata].join("\n\n"), {
    title: "Authored title",
    author: "Editorial team",
    digest: "Authored digest",
    sourceUrl: "https://example.com/original",
  });
  const section = compactSection(article.html);

  assert.equal((article.html.match(/参考文献/g) ?? []).length, 1);
  assert.equal((section.match(/<p\b[^>]*font-size:13px[^>]*>【\d+】/g) ?? []).length, 9);
  for (let n = 1; n <= 9; n++) {
    assert.equal((section.match(new RegExp(`【${n}】`, "g")) ?? []).length, 1);
    assert.ok(section.includes(`Author ${n}. Source ${n}`));
    if (n <= 3) assert.ok(section.includes(`and Supporting ${n}`));
  }
  assert.doesNotMatch(article.html, /https:\/\/example\.com|>References</);
  assert.doesNotMatch(section, /<a\b/);
  assert.match(article.html, /href="mailto:editor@example\.com"/);
  assert.doesNotMatch(section, /Created:/);
  assert.match(article.html, /<p\b[^>]*font-size:16px[^>]*>Created: 2026-09-07/);
  assert.ok(article.html.startsWith(render(body).html));
  assert.ok(article.html.endsWith(render(metadata).html));
  assert.equal(article.title, "Authored title");
  assert.equal(article.author, "Editorial team");
  assert.equal(article.digest, "Authored digest");
  assert.equal(article.sourceUrl, "https://example.com/original");
  assert.deepEqual(article.bodyImages, []);
  assert.ok(article.linkFlags.length >= 12);
  assert.ok(article.warnings.every((warning) => !/moved to bottom citations/.test(warning)));
});

test("WeChat removes reference links while preserving citations outside the authored section", () => {
  const article = render([
    "Body [original label](https://example.com/repeated), [repeated body label](https://example.com/repeated), " +
      "and [body-only source](https://example.com/body).",
    "## References",
    "[7] **Grouped author**: [First label](https://example.com/repeated), [Second label](https://example.com/other).",
    "[12] Another use of [Renamed source](https://example.com/repeated).",
    "Afterword [last label](https://example.com/after).",
  ].join("\n\n"));
  const section = compactSection(article.html, true);
  assert.match(article.html, /Body original label<sup[^>]*>\[1\]<\/sup>, repeated body label<sup[^>]*>\[1\]<\/sup>, and body-only source<sup[^>]*>\[2\]<\/sup>\./);
  assert.match(section, /\[7\] <strong[^>]*>Grouped author<\/strong>: First label, Second label\./);
  assert.match(section, /\[12\] Another use of Renamed source\./);
  assert.equal((section.match(/\[7\]/g) ?? []).length, 1);
  assert.equal((section.match(/\[12\]/g) ?? []).length, 1);
  assert.doesNotMatch(section, /https:\/\/example\.com|<ol\b|<a\b|<sup\b/);
  assert.doesNotMatch(section, /Afterword/);
  assert.match(article.html, /font-size:16px[^>]*>Afterword last label<sup[^>]*>\[3\]<\/sup>\./);
  assert.equal((article.html.match(/<sup\b/g) ?? []).length, 4);
  const footer = article.html.slice(article.html.lastIndexOf("<section"));
  assert.equal((footer.match(/<li\b/g) ?? []).length, 3);
  assert.match(footer, /original label — https:\/\/example\.com\/repeated/);
  assert.match(footer, /body-only source — https:\/\/example\.com\/body/);
  assert.match(footer, /last label — https:\/\/example\.com\/after/);
  assert.doesNotMatch(footer, /First label|Second label|Renamed source|repeated body label|example\.com\/other/);
  assert.ok(article.warnings.some((warning) => /3 external link\(s\) were moved to bottom citations/.test(warning)));
});

test("WeChat keeps nested list and inline formatting inside compact authored references", () => {
  const article = render([
    "## **Bibliography**",
    "",
    "7. **First author**. [*Primary source*](https://example.com/primary).",
    "   - Supporting **detail** with `code` and [nested source](https://example.com/nested).",
    "   - Another *nested entry*.",
    "8. Second author and ~~old edition~~.",
    "",
    "## Appendix",
    "",
    "Ordinary appendix.",
  ].join("\n"));
  const section = compactSection(article.html);
  assert.match(section, /<ol\b[^>]*start="7"[^>]*font-size:13px/);
  assert.match(section, /<ul\b[^>]*font-size:13px/);
  assert.equal((section.match(/<li\b/g) ?? []).length, 4);
  assert.match(section, /<strong[^>]*>First author<\/strong>/);
  assert.match(section, /<em[^>]*>Primary source<\/em>/);
  assert.match(section, /<code[^>]*>code<\/code>/);
  assert.match(section, /<del>old edition<\/del>/);
  assert.doesNotMatch(section, /font-size:16px|https:\/\//);
  assert.doesNotMatch(section, /Appendix/);
  assert.match(article.html, /<h2[^>]*font-size:20px[^>]*>Appendix<\/h2>/);
  assert.match(article.html, /font-size:16px[^>]*>Ordinary appendix\./);
});

test("WeChat preserves nonconsecutive authored ordered-list numbers", () => {
  const article = render([
    "## References",
    "",
    "3. [First source](https://example.com/first)",
    "7. [Other source](https://example.com/other)",
  ].join("\n"));
  const section = compactSection(article.html);
  assert.match(section, /<ol\b[^>]*start="3"[^>]*font-size:13px/);
  assert.deepEqual([...section.matchAll(/<li\b[^>]*value="(\d+)"/g)].map((match) => match[1]), ["3", "7"]);
  assert.match(section, /First source/);
  assert.match(section, /Other source/);
  assert.doesNotMatch(section, /font-size:16px|https:\/\//);
});

test("WeChat recognizes emphasized numbering and preserves escaped nested link labels", () => {
  const article = render(
    "## References\n\n**【9】** [*Research **R&D** and \\<guide\\>*](https://example.com/hidden)",
  );
  const section = compactSection(article.html);
  assert.match(section, /<p[^>]*font-size:13px[^>]*><strong[^>]*>【9】<\/strong>/);
  assert.match(section, /<em[^>]*>Research <strong[^>]*>R&amp;D<\/strong> and &lt;guide&gt;<\/em>/);
  assert.doesNotMatch(section, /<guide>|&amp;amp;|&amp;lt;|&amp;gt;|https:\/\/example\.com/);
});

test("WeChat recognizes only exact top-level reference headings with optional emphasis", () => {
  for (const heading of [
    "## Reference", "### rEfErEnCeS", "#### BIBLIOGRAPHY",
    "## 参考文献", "## 参考资料", "## **References**", "### *参考资料*",
  ]) {
    const article = render(`${heading}\n\n\n【1】 [Source](https://example.com/source)`);
    const section = compactSection(article.html);
    assert.match(section, /font-size:13px[^>]*>【1】 Source/);
    assert.doesNotMatch(article.html, /https:\/\/example\.com/);
  }

  for (const heading of [
    "## Further References", "## References and notes", "## References:",
    "## Sources", "## 参考链接", "## Not Bibliography",
  ]) {
    const article = render(`${heading}\n\n【1】 [Source](https://example.com/source)`);
    assert.match(article.html, /<sup[^>]*>\[1\]<\/sup>/, heading);
    assert.match(article.html, /font-size:16px[^>]*>【1】 Source/, heading);
    assert.match(article.html, /Source — https:\/\/example\.com\/source/, heading);
  }

  for (const markdown of [
    "> ## References\n>\n> 【1】 [Quoted](https://example.com/quoted)",
    "- ## References\n\n  【1】 [Nested](https://example.com/nested)",
  ]) {
    assert.match(render(markdown).html, /<sup[^>]*>\[1\]<\/sup>/);
  }
});

test("WeChat recognizes visible text entities without interpreting code-span entity source", () => {
  const encoded = render("## Refer&#101;nces\n\n&#12304;1&#12305; [Title](https://example.com/source)");
  const section = compactSection(encoded.html);
  assert.match(section, /<p\b[^>]*font-size:13px/);
  assert.match(section, /Title/);
  assert.doesNotMatch(encoded.html, /https:\/\/example\.com|<a\b/);

  const literal = render("## `Refer&#101;nces`\n\n【1】 [Title](https://example.com/source)");
  assert.match(literal.html, /<code[^>]*>Refer&amp;#101;nces<\/code>/);
  assert.match(literal.html, /font-size:16px[^>]*>【1】 Title<sup[^>]*>\[1\]<\/sup>/);
  assert.match(literal.html, /Title — https:\/\/example\.com\/source/);
});

test("WeChat accepts unordered references and preserves visible bare URL labels", () => {
  const article = render([
    "## References",
    "",
    "- Named [readable title](https://example.com/hidden-destination).",
    "- Bare https://example.com/visible and www.example.com/visible.",
    "- Autolink <https://example.com/autolink>.",
  ].join("\n"));
  const section = compactSection(article.html);
  assert.match(section, /<ul\b[^>]*font-size:13px/);
  assert.equal((section.match(/<li\b/g) ?? []).length, 3);
  assert.match(section, /Named readable title\./);
  assert.match(section, /Bare https:\/\/example\.com\/visible and www\.example\.com\/visible\./);
  assert.match(section, /Autolink https:\/\/example\.com\/autolink\./);
  assert.doesNotMatch(section, /<a\b|hidden-destination|http:\/\/www\.example\.com/);
});

test("WeChat closes compact references at the first other block", () => {
  const boundaries = [
    "Created: 2026-09-07",
    "## Following heading",
    "> Following quotation",
    "```text\nFollowing code\n```",
    "| Following table |\n| --- |\n| ordinary cell |",
    "---",
  ];
  for (const boundary of boundaries) {
    const article = render([
      "## References",
      "【1】 [First source](https://example.com/first)",
      boundary,
      "【2】 Following ordinary numbered paragraph.",
    ].join("\n\n"));
    const section = compactSection(article.html);
    assert.match(section, /【1】 First source/);
    assert.doesNotMatch(section, /Following|Created:|ordinary cell|【2】/);
    assert.ok(article.html.endsWith(render(`${boundary}\n\n【2】 Following ordinary numbered paragraph.`).html));
  }
});

test("WeChat keeps automatic URL-deduplicated citations when no populated authored section exists", () => {
  for (const prefix of [
    "",
    "## References\n\n",
    "## References\n\nThis is explanatory prose.\n\n",
    "## References\n\n## Ordinary heading\n\n",
  ]) {
    const article = render(prefix +
      "Body [First](https://example.com/shared), [Second](https://example.com/shared), " +
      "and [Third](https://example.com/other).");
    assert.equal((article.html.match(/<sup[^>]*>\[1\]<\/sup>/g) ?? []).length, 2);
    assert.equal((article.html.match(/<sup[^>]*>\[2\]<\/sup>/g) ?? []).length, 1);
    assert.equal((article.html.match(/<li\b/g) ?? []).length, 2);
    assert.match(article.html, /First — https:\/\/example\.com\/shared/);
    assert.match(article.html, /Third — https:\/\/example\.com\/other/);
    assert.doesNotMatch(article.html, /Second — /);
    assert.ok(article.warnings.some((warning) => /2 external link\(s\) were moved to bottom citations/.test(warning)));
  }
});

test("WeChat ignores empty recognized headings when selecting one authored bibliography", () => {
  const article = render([
    "## References",
    "This heading introduces prose only.",
    "## Bibliography",
    "[4] [Authored source](https://example.com/source)",
    "## 参考资料",
    "Nothing numbered here.",
  ].join("\n\n"));
  const section = compactSection(article.html);
  assert.match(section, /Bibliography/);
  assert.match(section, /\[4\] Authored source/);
  assert.doesNotMatch(section, /References|参考资料|Nothing numbered|introduces prose/);
});

test("WeChat restores normal styles and citation behavior in subsequent article generations", () => {
  const markdown = "## Overview\n\nOrdinary paragraph.\n\n- [Source](https://example.com/source)";
  const before = render(markdown);
  compactSection(render("## References\n\n- [Authored source](https://example.com/authored)").html);
  const after = render(markdown);
  assert.equal(after.html, before.html);
  assert.deepEqual(after.warnings, before.warnings);
  assert.match(after.html, /<h2[^>]*font-size:20px[^>]*>Overview<\/h2>/);
  assert.match(after.html, /<p[^>]*font-size:16px[^>]*>Ordinary paragraph\./);
  assert.match(after.html, /<ul[^>]*font-size:16px/);
  assert.match(after.html, /Source<sup[^>]*>\[1\]<\/sup>/);
});

test("WeChat rejects multiple populated bibliographies before cover reads even with keep-links", () => {
  for (const keepLinks of [false, true]) {
    for (const second of ["## Bibliography\n\n- Second source.", "## References\n\n[9] Second source."]) {
      expectLocalError(
        `## References\n\n【1】 First source.\n\n${second}`,
        "wechat_bibliography_ambiguous",
        keepLinks,
      );
    }
  }
});

test("WeChat removes every safe reference anchor while preserving native and non-HTTP anchors outside", () => {
  const article = render([
    "Body [native](https://mp.weixin.qq.com/s?id=1&lang=en), [relative](../guide), " +
      "[mail](mailto:editor@example.com), and [fragment](#part).",
    "## References",
    "【1】 [Native source](https://mp.weixin.qq.com/s/entry) and [External source](https://example.com/source).",
    "【2】 [Local source](./guide?a=1&b=2), [Address](mailto:editor@example.com), [Part](#part).",
  ].join("\n\n"));
  const section = compactSection(article.html);
  for (const href of [
    "https://mp.weixin.qq.com/s?id=1&amp;lang=en", "../guide", "mailto:editor@example.com", "#part",
  ]) assert.ok(article.html.includes(`href="${href}"`), href);
  assert.doesNotMatch(section, /<a\b|https:\/\/|\.\/guide|mailto:|#part/);
  assert.match(section, /【1】 Native source and External source\./);
  assert.match(section, /【2】 Local source, Address, Part\./);
  assert.doesNotMatch(article.html, /https:\/\/example\.com\/source/);
});

test("WeChat keep-links retains safe anchors while compacting the same authored section", () => {
  const markdown = [
    "Body [external](https://example.com/body).",
    "## References",
    "【1】 [**Named source**](<https://example.com/source?a=1&note=\"quoted\">) and https://example.com/bare.",
    "【2】 [Native](https://mp.weixin.qq.com/s/entry), [local](./guide), and www.example.com/visible.",
    "Created: 2026-09-07",
  ].join("\n\n");
  const article = render(markdown, { keepLinks: true });
  const section = compactSection(article.html);
  for (const href of [
    "https://example.com/body", "https://example.com/source?a=1&amp;note=&quot;quoted&quot;",
    "https://example.com/bare", "https://mp.weixin.qq.com/s/entry", "./guide", "http://www.example.com/visible",
  ]) assert.ok(article.html.includes(`href="${href}"`), href);
  assert.match(section, /font-size:13px[^>]*>【1】/);
  assert.match(section, /<strong[^>]*>Named source<\/strong>/);
  assert.doesNotMatch(section, /Created:/);
  assert.match(article.html, /font-size:16px[^>]*>Created: 2026-09-07/);
});

test("WeChat validates authored reference HTML and link destinations before reading assets", () => {
  for (const keepLinks of [false, true]) {
    expectLocalError(
      "## References\n\n【1】 Source <img src=x onerror=alert(1)>.",
      "wechat_raw_html_unsupported",
      keepLinks,
    );
    expectLocalError(
      "## References\n\n- **Source**\n  - [unsafe](java%73cript%3Aalert(1))",
      "wechat_url_unsafe",
      keepLinks,
    );
    expectLocalError(
      "## References\n\n【1】 [Source](https://example.com/safe)\n\nAfterword [unsafe](data:text/html,bad)",
      "wechat_url_unsafe",
      keepLinks,
    );
  }
});
