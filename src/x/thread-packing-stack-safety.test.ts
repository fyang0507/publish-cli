import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { countXWeightedLength } from "../capabilities/validation.js";
import { generateContent } from "./content.js";

test("X thread packing handles oversized prose on both sides of fenced code without platform access", async () => {
  const words = "a b c d e f g h i j k l m n o p q r s t u v w x";
  const paragraphs = Array.from(
    { length: 12_000 },
    (_, index) =>
      `paragraph-${String(index).padStart(5, "0")} ` +
      `${words} payload-xxxxxxxxxxxxxxxx`,
  );
  const left = paragraphs.slice(0, 6_000).join("\n\n");
  const right = paragraphs.slice(6_000).join("\n\n");
  const fencedSource = "```txt\nsentinel\n```";
  const placeholder = "[code block #1 → screenshot]";
  const source = `${left}\n\n${fencedSource}\n\n${right}`;
  const expectedTransport = `${left}\n\n${placeholder}\n\n${right}`;

  // generateContent is the pure generation boundary: it has no browser,
  // profile, session, API, or platform dependency.
  const generated = await generateContent(source, { format: "thread" });
  const repeated = await generateContent(source, { format: "thread" });
  const posts = generated.thread ?? [];
  const reconstructed = posts
    .map((post) => post.text.replace(/ \d+\/\d+$/u, ""))
    .join("");
  const codeFlags = generated.fidelityFlags.filter((flag) => flag.kind === "code_block");

  assert.equal(paragraphs.length, 12_000);
  assert.ok(Buffer.byteLength(source, "utf8") > 1_000_000);
  assert.ok(posts.length > 1);
  assert.equal(reconstructed, expectedTransport);
  assert.equal(JSON.stringify(repeated), JSON.stringify(generated));
  assert.equal(posts.filter((post) => post.text.includes(placeholder)).length, 1);
  assert.ok(
    posts.every(
      (post) => post.chars === countXWeightedLength(post.text) && post.chars <= 280,
    ),
  );
  assert.equal(codeFlags.length, 1);
  assert.equal(codeFlags[0]?.placeholder, placeholder);
  assert.equal(
    codeFlags[0]?.normalizedSourceSha256,
    createHash("sha256").update(fencedSource, "utf8").digest("hex"),
  );
});
