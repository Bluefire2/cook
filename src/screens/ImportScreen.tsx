import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import RecipeForm from '../components/RecipeForm';
import { SpinnerIcon } from '../lib/icons';
import { importRecipe, type ExtractedRecipe } from '../lib/importApi';
import {
  parseImportInput,
  validateImportInput,
} from '../lib/importInput';
import { recipeStore } from '../lib/recipeStore';
import { backLink, inputFocus, primaryBtn, secondaryBtn } from '../lib/uiClasses';
import type { RecipeDraft } from '../lib/types';

const SESSION_EXPIRED = 'Please sign in again — your session expired.';

type BulkResult =
  | { url: string; ok: true; id: string; title: string }
  | { url: string; ok: false; error: string };

export default function ImportScreen() {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [bulk, setBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExtractedRecipe | null>(null);
  const [summary, setSummary] = useState<BulkResult[] | null>(null);

  const extract = async () => {
    if (busy) return;
    const parsed = parseImportInput(input);
    if (parsed.kind === 'empty') return;
    const validated = validateImportInput(parsed, bulk);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (validated.mode === 'bulk') {
        const results: BulkResult[] = [];
        for (let i = 0; i < validated.urls.length; i++) {
          const url = validated.urls[i];
          if (url === undefined) {
            continue;
          }
          setProgress({ current: i + 1, total: validated.urls.length });
          try {
            const draft = await importRecipe({ url });
            const recipe = await recipeStore.create(draft);
            results.push({
              url,
              ok: true,
              id: recipe.id,
              title: recipe.title.trim() === '' ? url : recipe.title,
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : 'Import failed.';
            results.push({ url, ok: false, error: message });
            if (message === SESSION_EXPIRED) {
              for (const rest of validated.urls.slice(i + 1)) {
                results.push({ url: rest, ok: false, error: SESSION_EXPIRED });
              }
              break;
            }
          }
        }
        setSummary(results);
        setProgress(null);
        return;
      }
      setPreview(
        await importRecipe(
          validated.mode === 'url'
            ? { url: validated.url }
            : { text: validated.text },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  const tryAgain = () => {
    if (summary === null) return;
    const failed = summary.filter((row) => !row.ok).map((row) => row.url);
    setInput(failed.join('\n'));
    setSummary(null);
    setError(null);
  };

  const save = async (draft: RecipeDraft) => {
    const recipe = await recipeStore.create(draft);
    navigate(`/recipe/${recipe.id}`, { replace: true });
  };

  const successCount = summary?.filter((row) => row.ok).length ?? 0;
  const failedCount = summary === null ? 0 : summary.length - successCount;

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className={backLink}>
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Import recipe</h1>
      </header>

      {summary !== null ? (
        <>
          <h2 className="text-lg font-semibold">
            {successCount === 0
              ? "Couldn't import these recipes"
              : `Imported ${successCount} of ${summary.length}`}
          </h2>
          <ul className="mt-3 space-y-2">
            {summary.map((row) => (
              <li
                key={row.url}
                className="rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-sm"
              >
                {row.ok ? (
                  <>
                    <Link
                      to={`/recipe/${row.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {row.title}
                    </Link>
                    <p className="mt-1 break-all text-ink-subtle">{row.url}</p>
                  </>
                ) : (
                  <>
                    <p className="break-all text-ink">{row.url}</p>
                    <p className="mt-1 text-danger">{row.error}</p>
                  </>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => navigate('/')}
            className={`${primaryBtn} mt-4 w-full py-3`}
          >
            Back to library
          </button>
          {failedCount > 0 && (
            <button
              type="button"
              onClick={tryAgain}
              className={`${secondaryBtn} mt-2 w-full py-3`}
            >
              Try again
            </button>
          )}
        </>
      ) : preview === null ? (
        <>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={5}
            readOnly={busy}
            placeholder={
              bulk
                ? 'Paste one recipe link per line…'
                : 'Paste a recipe link, or the recipe text itself…'
            }
            className={`w-full rounded-xl border border-line bg-surface px-4 py-3 shadow-sm ${inputFocus}`}
          />
          <label className="mt-3 flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={bulk}
              disabled={busy}
              onChange={(e) => {
                setBulk(e.target.checked);
                setError(null);
              }}
              className={`mt-1 h-4 w-4 shrink-0 accent-ink disabled:opacity-40 ${inputFocus}`}
            />
            <span>
              <span className="block font-medium text-ink">Bulk import</span>
              <span className="mt-0.5 block text-sm text-ink-subtle">
                Paste several recipe links. Each is saved to your library
                without a preview.
              </span>
            </span>
          </label>
          {error && (
            <p className="mt-2 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void extract()}
            disabled={input.trim() === ''}
            aria-busy={busy || undefined}
            aria-disabled={busy || input.trim() === ''}
            className={`${primaryBtn} mt-3 inline-flex w-full items-center justify-center gap-2 py-3 ${busy ? 'pointer-events-none' : ''}`}
          >
            {busy && <SpinnerIcon className="block h-5 w-5 animate-spin" />}
            {busy
              ? 'Extracting…'
              : bulk
                ? 'Extract recipes'
                : 'Extract recipe'}
          </button>
          {busy && progress && (
            <div className="mt-3">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.current}
                aria-valuetext={`Reading recipe ${progress.current} of ${progress.total}`}
                aria-label="Bulk import progress"
                className="h-2 w-full overflow-hidden rounded-full bg-line"
              >
                <div
                  className="h-full rounded-full bg-ink transition-[width] duration-300 ease-out"
                  style={{
                    width: `${Math.round(
                      (progress.current / progress.total) * 100,
                    )}%`,
                  }}
                />
              </div>
              <p
                className="mt-2 text-center text-sm text-ink-subtle"
                role="status"
              >
                Reading recipe {progress.current} of {progress.total} — this
                takes a few seconds.
              </p>
            </div>
          )}
          {busy && !progress && (
            <p className="mt-3 text-center text-sm text-ink-subtle" role="status">
              Reading the recipe — this takes a few seconds.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="rounded-2xl border border-line bg-accent-soft px-4 py-3 text-sm text-ink">
            Anything the extraction got wrong, fix it here before saving.
          </div>

          <RecipeForm
            initial={preview}
            submitLabel="Save to library"
            onSubmit={save}
            onCancel={() => setPreview(null)}
          />
        </>
      )}
    </div>
  );
}
