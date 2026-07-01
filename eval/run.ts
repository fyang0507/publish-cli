/**
 * Triage eval harness (issue #7).
 *
 * Loads a small hand-labeled dataset (posts + a boolean `worth-reply` label),
 * runs the SAME `triagePosts` the watch loop uses across a sweep of
 * {batch size} × {model} × {reasoning effort}, then reports agreement /
 * precision / recall / F1 against the labels. This makes the batch-size choice
 * (and future prompt changes) data-driven instead of intuition, and doubles as
 * a regression check.
 *
 * IT READS THE REAL CODE (imports triagePosts from ../dist) but is NETWORK-SAFE
 * by default: it does NOT call Gemini unless you pass `--run` (or EVAL_RUN=1).
 * A dry run just validates the dataset and prints the sweep matrix + prompt
 * sizes, so it's safe to execute in CI / during build.
 *
 * Run it (Node >= 22.6 strips TS types natively; this repo targets Node 25):
 *   node --experimental-strip-types eval/run.ts                 # dry run, no network
 *   node --experimental-strip-types eval/run.ts --run           # LIVE: calls Gemini
 *   node --experimental-strip-types eval/run.ts --run \
 *       --dataset eval/dataset.json \
 *       --batch-sizes 10,25,50 \
 *       --models gemini-3.5-flash \
 *       --efforts minimal,low \
 *       --threshold 60
 *
 * Requires `dist/` to be built first (`npm run build`) so the imports resolve.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { triagePosts, type TriagedPost } from "../dist/x/triage.js";
import { GeminiClient } from "../dist/gemini.js";
import type { XPost } from "../dist/x/reader.js";
import type { TriageConfig } from "../dist/config.js";

// --- Dataset shape ---------------------------------------------------------

interface LabeledPost extends XPost {
  /** Human judgment: true = worth a reply from the persona, false = not. */
  label: boolean;
}

interface Dataset {
  persona?: string;
  dimensions?: string[];
  posts: LabeledPost[];
}

// --- CLI args (tiny hand-rolled parser; no extra deps) ---------------------

interface Args {
  run: boolean;
  dataset: string;
  batchSizes: number[];
  models: string[];
  efforts: string[];
  /** 0-100 gate mapped to the 0-1 triage score to derive predicted labels. */
  threshold: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const nums = (s: string | undefined, d: number[]): number[] =>
    s ? s.split(",").map((x) => Number.parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0) : d;
  const strs = (s: string | undefined, d: string[]): string[] =>
    s ? s.split(",").map((x) => x.trim()).filter(Boolean) : d;

  return {
    run: argv.includes("--run") || process.env.EVAL_RUN === "1",
    dataset: get("dataset") ?? "eval/dataset.sample.json",
    batchSizes: nums(get("batch-sizes"), [10, 25, 50]),
    models: strs(get("models"), [process.env.TRIAGE_MODEL ?? "gemini-3.5-flash"]),
    // "minimal" | "low" | "medium" | "high" — passed straight to Gemini's thinkingLevel.
    efforts: strs(get("efforts"), ["low"]),
    threshold: Number.parseInt(get("threshold") ?? "60", 10),
  };
}

// --- Metrics ---------------------------------------------------------------

interface Metrics {
  n: number;
  agreement: number; // (tp+tn)/n
  precision: number; // tp/(tp+fp)
  recall: number; // tp/(tp+fn)
  f1: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** posts the model never returned a verdict for (score defaulted to 0). */
  missing: number;
}

function score(labels: Map<string, boolean>, triaged: TriagedPost[], threshold01: number): Metrics {
  let tp = 0, fp = 0, tn = 0, fn = 0, missing = 0;
  const returned = new Set<string>();
  for (const t of triaged) {
    returned.add(t.post.id);
    const truth = labels.get(t.post.id);
    if (truth === undefined) continue;
    if (t.triage.reason === "no triage verdict returned for this post") missing++;
    const pred = t.triage.score >= threshold01;
    if (pred && truth) tp++;
    else if (pred && !truth) fp++;
    else if (!pred && !truth) tn++;
    else fn++;
  }
  const n = tp + fp + tn + fn;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { n, agreement: n === 0 ? 0 : (tp + tn) / n, precision, recall, f1, tp, fp, tn, fn, missing };
}

// --- Gemini client that lets the sweep pick the reasoning effort -----------

/**
 * triagePosts calls `gemini.triage(model, prompt)` with a fixed default effort.
 * To sweep effort we wrap a real client and force a chosen thinkingLevel.
 */
function clientForEffort(effort: string): GeminiClient {
  const base = new GeminiClient();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "triage") {
        return (model: string, prompt: string) =>
          // generate() takes thinkingLevel as its 3rd arg; effort is a ThinkingLevel string.
          (target as unknown as { generate: (m: string, p: string, e: string) => Promise<string> })
            .generate(model, prompt, effort);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(process.cwd(), args.dataset);
  const ds = JSON.parse(readFileSync(path, "utf-8")) as Dataset;

  if (!Array.isArray(ds.posts) || ds.posts.length === 0) {
    throw new Error(`dataset ${path} has no posts[]`);
  }
  const ids = new Set<string>();
  for (const p of ds.posts) {
    if (!p.id) throw new Error("every dataset post needs a unique `id`");
    if (ids.has(p.id)) throw new Error(`duplicate post id in dataset: ${p.id}`);
    ids.add(p.id);
    if (typeof p.label !== "boolean") throw new Error(`post ${p.id} needs a boolean \`label\``);
  }
  const labels = new Map(ds.posts.map((p) => [p.id, p.label]));
  const positives = ds.posts.filter((p) => p.label).length;

  const triageConfig: TriageConfig = {
    persona: ds.persona ?? "",
    dimensions: ds.dimensions ?? ["fit", "timeliness", "unique_value"],
    min_score: args.threshold,
    batch_size: args.batchSizes[0] ?? 25,
  };

  console.log(`Dataset: ${path}`);
  console.log(`  ${ds.posts.length} posts (${positives} labeled worth-reply, ${ds.posts.length - positives} not)`);
  console.log(`Sweep: batchSizes=[${args.batchSizes}] models=[${args.models}] efforts=[${args.efforts}] threshold=${args.threshold}/100`);
  console.log("");

  if (!args.run) {
    console.log("DRY RUN (no --run / EVAL_RUN=1): validated dataset, NOT calling Gemini.");
    console.log(`Would run ${args.batchSizes.length * args.models.length * args.efforts.length} configuration(s).`);
    console.log("Re-run with `--run` to execute live triage against Gemini.");
    return;
  }

  const posts = ds.posts.map(({ label: _label, ...rest }) => rest as XPost);
  const threshold01 = args.threshold / 100;

  console.log("config".padEnd(42), "agree", "  prec", "   rec", "    f1", " miss");
  console.log("-".repeat(78));
  for (const model of args.models) {
    for (const effort of args.efforts) {
      for (const batchSize of args.batchSizes) {
        const client = clientForEffort(effort);
        const triaged = await triagePosts(posts, triageConfig, model, client, batchSize);
        const m = score(labels, triaged, threshold01);
        const label = `${model} | ${effort} | bs=${batchSize}`;
        console.log(
          label.padEnd(42),
          pct(m.agreement),
          pct(m.precision),
          pct(m.recall),
          pct(m.f1),
          String(m.missing).padStart(4),
        );
      }
    }
  }
  console.log("");
  console.log("Legend: agree = (correct predictions)/n; miss = posts the model returned no verdict for");
  console.log("(a rising `miss` as batch size grows is the truncated-JSON failure mode issue #7 warns about).");
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`.padStart(6);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
