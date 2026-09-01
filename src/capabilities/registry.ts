import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { AUTH_PLATFORMS, type AuthPlatform } from "../auth/types.js";
import {
  CHANNEL_INFO_SOURCE_SCHEMA_VERSION,
  type ChannelInfoSource,
} from "./types.js";

const SOURCE_DIRECTORY = fileURLToPath(new URL("../../capabilities/", import.meta.url));
const REQUIRED_SECTIONS = [
  "CLI boundary",
  "Authentication",
  "Platform specification and gotchas",
] as const;

function requireString(value: unknown, field: string, sourceName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${sourceName}: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function parseFrontmatter(markdown: string, sourceName: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${sourceName}: expected YAML frontmatter.`);

  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceName}: frontmatter must be a mapping.`);
  }
  return { metadata: parsed as Record<string, unknown>, body: match[2] };
}

function parseSections(body: string, displayName: string, sourceName: string): Record<string, string> {
  const lines = body.split("\n");
  const titleIndexes = lines
    .map((line, index) => (/^#(?!#)\s+/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (titleIndexes.length !== 1) {
    throw new Error(`${sourceName}: expected exactly one H1 title.`);
  }

  const title = lines[titleIndexes[0]].replace(/^#\s+/, "").trim();
  if (title !== displayName) {
    throw new Error(`${sourceName}: H1 must match displayName "${displayName}".`);
  }

  const headings = lines
    .map((line, index) => {
      const match = line.match(/^##(?!#)\s+(.+?)\s*$/);
      return match ? { name: match[1], index } : null;
    })
    .filter((item): item is { name: string; index: number } => item !== null);

  const names = headings.map((heading) => heading.name);
  if (
    names.length !== REQUIRED_SECTIONS.length ||
    names.some((name, index) => name !== REQUIRED_SECTIONS[index])
  ) {
    throw new Error(
      `${sourceName}: expected exactly these H2 sections in order: ${REQUIRED_SECTIONS.join(", ")}.`,
    );
  }

  const beforeFirstSection = lines
    .slice(titleIndexes[0] + 1, headings[0].index)
    .join("\n")
    .trim();
  if (beforeFirstSection) {
    throw new Error(`${sourceName}: put all guidance inside the three required sections.`);
  }

  return Object.fromEntries(
    headings.map((heading, index) => {
      const end = headings[index + 1]?.index ?? lines.length;
      const content = lines.slice(heading.index + 1, end).join("\n").trim();
      if (!content) throw new Error(`${sourceName}: section "${heading.name}" must not be empty.`);
      return [heading.name, content];
    }),
  );
}

export function parseChannelInfoMarkdown(
  markdown: string,
  sourceName = "channel info source",
  expectedChannel?: AuthPlatform,
): ChannelInfoSource {
  const { metadata, body } = parseFrontmatter(markdown, sourceName);
  const schemaVersion = requireString(metadata.schemaVersion, "schemaVersion", sourceName);
  if (schemaVersion !== CHANNEL_INFO_SOURCE_SCHEMA_VERSION) {
    throw new Error(
      `${sourceName}: schemaVersion must be ${CHANNEL_INFO_SOURCE_SCHEMA_VERSION}.`,
    );
  }

  const channel = requireString(metadata.channel, "channel", sourceName);
  if (!(AUTH_PLATFORMS as readonly string[]).includes(channel)) {
    throw new Error(`${sourceName}: unknown channel "${channel}".`);
  }
  if (expectedChannel && channel !== expectedChannel) {
    throw new Error(`${sourceName}: expected channel "${expectedChannel}", got "${channel}".`);
  }

  const displayName = requireString(metadata.displayName, "displayName", sourceName);
  const sections = parseSections(body, displayName, sourceName);
  return {
    schemaVersion: CHANNEL_INFO_SOURCE_SCHEMA_VERSION,
    channel: channel as AuthPlatform,
    displayName,
    cliBoundary: sections["CLI boundary"],
    authentication: sections.Authentication,
    platformGuidance: sections["Platform specification and gotchas"],
  };
}

function loadChannelInfoSources(): Readonly<Record<AuthPlatform, ChannelInfoSource>> {
  const entries = AUTH_PLATFORMS.map((channel) => {
    const path = `${SOURCE_DIRECTORY}${channel}.md`;
    const source = parseChannelInfoMarkdown(readFileSync(path, "utf8"), path, channel);
    return [channel, Object.freeze(source)] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<AuthPlatform, ChannelInfoSource>>;
}

export const CHANNEL_INFO_SOURCES = loadChannelInfoSources();

export function getChannelInfoSource(channel: AuthPlatform): ChannelInfoSource {
  return CHANNEL_INFO_SOURCES[channel];
}
