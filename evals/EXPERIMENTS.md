# Experiments

Append-only log of changes to import prompts, model settings, output checks,
retry policy, and goldens. `evals/AGENTS.md` defines when an entry is
required. Newest first.

Record aggregate numbers only: dev per fixture, holdout as a pass count.
Never record transcriptions or judge reasons. The notes are personal data,
and holdout must stay unseen. The `passes` numbers come from the `ocrCompare`
summary, approach A.

## Entry template

```
## <YYYY-MM-DD> — <short name>
- Change: <what changed; commit(s)>
- Reason (not fixture-specific): <…>
- Command: npm run eval:ocr-compare -- --split=all --runs=<n> [--thinking=…]
- Before (<sha>): dev <x>/<y>, holdout <x>/<y>; notable finishes/calls: <e.g. MAX_TOKENS 1, calls>1 in 2 runs>
- After (<sha>): dev <x>/<y>, holdout <x>/<y>; notable finishes/calls: <…>
- Decision: kept | reverted | pending owner run — <why, per the acceptance rule>
- Run by: <owner | agent>, model <CHAT_MODEL or default>
```

## 2026-09-27 — Photo import: runaway-unit check (32) and one retry

- Change: `importFromImages` treats an ingredient `unit` longer than 32
  characters (`MAX_PHOTO_UNIT_CHARS`, after trimming) as `unusable`, and
  makes exactly one identical retry when the outcome is `parse_error` or
  `unusable`. Constitution principle 1 amended. Commit: `Photo import:
  runaway-unit check…` (this commit; fill SHA when the owner runs the
  measurement).
- Reason (not fixture-specific): truncated JSON and reasoning written into a
  field are sampling failures. A second sample of the same call usually
  avoids them. The length check reads no card content.
- Command: npm run eval:ocr-compare -- --split=all --runs=3
- Before (63e41ba6cbe4994483d0526b2c84fa5fac4520ad): dev pending owner run, holdout pending owner run
- After: this commit (fill SHA when the owner runs the measurement): dev pending owner run, holdout pending owner run
- Decision: pending owner run — do not merge until filled in; revert this
  commit (including the P1 amendment) if holdout or dev is worse
- Run by: pending owner run, model CHAT_MODEL or default

## 2026-09-27 — Dev/holdout split

- Change: `git mv` of the 10 handwritten fixtures into
  `evals/import-handwritten/dev/` and `holdout/`. No behaviour change.
  dev: `blueberry-muffins`, `choc-pie-tea-towel`, `hundred-good-cookies`,
  `lemon-tea-bread`, `sweet-sour-pork` (already inspected, debugged, or
  golden-adjusted: `803f29c`, `58d193a`). holdout: `broccoli-salad`,
  `peanut-butter-cookies`, `potatoe-pancakes-platter`, `split-pea-soup`,
  `taffy-apple-salad` (not used for debugging or prompt tuning; the taffy
  golden was reconciled in `f6f7b72` against an independent transcription,
  not against model output).
- Reason (not fixture-specific): cards already looked at cannot be treated as
  unseen. The split separates them from cards not used to design a change.
- Command: none. A fixture move; no measurement is needed.
- Before: n/a
- After: n/a
- Decision: kept — fixture move only; no measurement is needed.
- Run by: agent, no model run

## 2026-09-27 — Recipe-card shorthand line in the photo prompt (`58d193a`, reverted `0b7d79e`)

- Change: `58d193a` added a photo-prompt line about recipe-card shorthand
  (`#` after a number means pounds, and tablespoon abbreviations). Reverted
  in `0b7d79e`.
- Reason (not fixture-specific): none. Written from one card. Not a valid
  experiment. See the worked example in `evals/AGENTS.md`.
- Command: measured only on `sweet-sour-pork`, not
  `npm run eval:ocr-compare -- --split=all --runs=3`.
- Before: not recorded across both splits
- After: not recorded across both splits
- Decision: reverted — measured only on `sweet-sour-pork`, so it is not a
  valid experiment. See the worked example in `evals/AGENTS.md`.
- Run by: agent (`58d193a`); owner reverted (`0b7d79e`); model not recorded

## 2026-09-27 — Photos to Gemini vs Vision OCR then Gemini (P2)

- Change: none here. Copy of numbers already recorded in constitution
  principle 2 (`docs/constitutions/image-import.md`). Not a new claim.
- Reason (not fixture-specific): compare photos straight to Gemini with
  Vision OCR then Gemini. Recorded before the split.
- Command: `evals/ocrCompare.ts`, before the split, 3 cards × 3 runs.
- Before (pre-split): approach A 6/9, approach B 3/9; median 3.5 s against
  5.7 s; mean cost about $0.013 against $0.012 per import. These are not
  dev/holdout counts.
- After: n/a — this entry copies the recorded numbers; it is not a new run.
- Decision: kept — copy of the numbers already in constitution P2, not a new
  claim.
- Run by: copied from constitution P2, not a new run
