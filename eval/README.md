# Triage eval harness

Make the triage `batch_size` (and model / reasoning-effort) choice **data-driven**
instead of intuition, and give future prompt changes a regression check.
See issue #7.

The harness runs the **same `triagePosts`** the watch loop uses over a sweep of
`{batch size} × {model} × {reasoning effort}` against a small hand-labeled
dataset, then reports agreement / precision / recall / F1.

## Files

- `run.ts` — the harness. Imports the real code from `dist/`; **network-safe by
  default** (no Gemini calls unless you pass `--run`).
- `dataset.sample.json` — a tiny placeholder dataset (6 obvious examples) so the
  harness runs out of the box. **Replace it with real labels** (below).

## Prerequisites

- Build first so `dist/` exists: `npm run build`.
- Node ≥ 22.6 (this repo targets Node 25) — it strips TypeScript types natively,
  so `run.ts` executes directly.
- For a **live** run: `GOOGLE_GENERATIVE_AI_API_KEY` in `.env` (same as the CLI).

## Usage

Dry run — validates the dataset and prints the sweep matrix, **no network**:

```bash
node --experimental-strip-types eval/run.ts
```

Live run — **calls Gemini** for each configuration:

```bash
node --experimental-strip-types eval/run.ts --run \
  --dataset eval/dataset.json \
  --batch-sizes 10,25,50 \
  --models gemini-3.5-flash \
  --efforts minimal,low \
  --threshold 60
```

Flags (all optional; sensible defaults shown in `run.ts`):

| flag | meaning | default |
|------|---------|---------|
| `--run` (or `EVAL_RUN=1`) | actually call Gemini; omit for a dry run | off |
| `--dataset <path>` | labeled dataset JSON | `eval/dataset.sample.json` |
| `--batch-sizes a,b,c` | batch sizes to sweep | `10,25,50` |
| `--models a,b` | model ids to sweep | `$TRIAGE_MODEL` or `gemini-3.5-flash` |
| `--efforts minimal,low,medium,high` | Gemini `thinkingLevel`s to sweep | `low` |
| `--threshold <0-100>` | score gate → predicted worth-reply label | `60` |

## How Fred adds real labels

1. Copy `dataset.sample.json` to `dataset.json` (gitignored-friendly; keep the
   sample as the committed placeholder).
2. Collect ~50 real posts. Easiest source: run `publish watch x --json --no-triage`
   (issue #6) and copy the emitted `posts[]` — each entry is already the right
   shape (`id`, `url`, `authorHandle`, `text`, `createdAt`, `origin`, `metrics`).
3. For each post add a boolean **`label`**: `true` if it's genuinely worth a reply
   from the persona, `false` otherwise. Aim for a realistic positive/negative mix.
4. Set `persona` and `dimensions` at the top of the file to the rubric you want to
   evaluate (mirrors watch.yaml's `triage:` block / the `--persona` you'd pass).
5. Run the sweep and pick the batch size with the best F1 that doesn't inflate the
   `miss` column — a rising `miss` (posts the model returned no verdict for) as
   batch size grows is exactly the truncated-JSON failure mode issue #7 warns
   about (the output-length cap), the signal that a batch size is too big.

## Notes

- The harness maps triage scores to predicted labels with `--threshold` (the same
  0-100 → 0-1 mapping the watch loop's `min_score` uses), so "precision" here means
  "of the posts triage would surface, how many were truly worth a reply."
- Reasoning-effort sweep works by wrapping `GeminiClient` so each run forces a
  chosen `thinkingLevel`; the production default stays `low` (see `src/gemini.ts`).
