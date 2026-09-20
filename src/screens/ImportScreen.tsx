import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CreateRecipeForm from '../components/CreateRecipeForm';
import SaveToCollectionSheet from '../components/SaveToCollectionSheet';
import { collectionStore, libraryHref, useCollections } from '../lib/collectionStore';
import { resolveCollectionDestination } from '../lib/collectionDestination';
import { SpinnerIcon } from '../lib/icons';
import { importRecipe, type ExtractedRecipe } from '../lib/importApi';
import {
  parseImportInput,
  validateImportInput,
} from '../lib/importInput';
import { recipeStore } from '../lib/recipeStore';
import { backLink, inputFocus, primaryBtn, secondaryBtn } from '../lib/uiClasses';

const SESSION_EXPIRED = 'Please sign in again — your session expired.';

type BulkResult =
  | { url: string; ok: true; id: string; title: string }
  | { url: string; ok: false; error: string };

export default function ImportScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const collectionId = params.get('c') ?? undefined;
  // Subscribed, not a one-shot store read: on a cold load of `?c=<id>` the
  // pull has not landed yet, and only a subscriber re-renders once it does.
  const collections = useCollections();
  const knownCollectionId =
    collectionId && collections?.some((c) => c.id === collectionId)
      ? collectionId
      : undefined;
  const backTo = libraryHref(knownCollectionId);
  const [input, setInput] = useState('');
  const [bulk, setBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExtractedRecipe | null>(null);
  const [pendingUrls, setPendingUrls] = useState<string[] | null>(null);
  const [batchDestination, setBatchDestination] = useState<string | null | undefined>();
  const [retrying, setRetrying] = useState(false);
  const inFlight = useRef(false);
  const [summary, setSummary] = useState<BulkResult[] | null>(null);

  const runBulk = async (urls: string[], destinationId: string | undefined) => {
    if (inFlight.current) return;
    if (destinationId && !collectionStore.get(destinationId)) {
      throw new Error('Collection not found. Choose another collection.');
    }
    inFlight.current = true;
    setBatchDestination(destinationId ?? null);
    setPendingUrls(null);
    setBusy(true);
    setError(null);
    try {
      const results: BulkResult[] = [];
      for (const [i, url] of urls.entries()) {
        setProgress({ current: i + 1, total: urls.length });
        try {
          if (destinationId && !collectionStore.get(destinationId)) {
            throw new Error('Collection not found. Choose another collection.');
          }
          const draft = await importRecipe({ url });
          const recipe = await recipeStore.create(
            draft,
            destinationId ? { collectionId: destinationId } : undefined,
          );
          results.push({ url, ok: true, id: recipe.id, title: recipe.title.trim() || url });
        } catch (e) {
          const message = e instanceof Error ? e.message : 'Import failed.';
          results.push({ url, ok: false, error: message });
          if (message === SESSION_EXPIRED || (destinationId && !collectionStore.get(destinationId))) {
            for (const rest of urls.slice(i + 1)) {
              results.push({ url: rest, ok: false, error: message });
            }
            break;
          }
        }
      }
      setSummary(results);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setProgress(null);
    }
  };

  const extract = async () => {
    if (inFlight.current || pendingUrls || collections === undefined) return;
    const parsed = parseImportInput(input);
    if (parsed.kind === 'empty') return;
    const validated = validateImportInput(parsed, bulk);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setError(null);
    const urls = validated.mode === 'bulk'
      ? validated.urls
      : retrying && validated.mode === 'url' ? [validated.url] : null;
    if (urls) {
      const destination = resolveCollectionDestination(collections, collectionId, batchDestination);
      if (destination.kind === 'choose') {
        setPendingUrls(urls);
      } else if (destination.kind === 'save') {
        try {
          await runBulk(urls, destination.collectionId);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Import failed.');
          setPendingUrls(urls);
        }
      }
      return;
    }
    if (validated.mode === 'bulk') return;
    inFlight.current = true;
    setBusy(true);
    try {
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
      inFlight.current = false;
      setBusy(false);
    }
  };

  const tryAgain = () => {
    if (summary === null) return;
    const failed = summary.filter((row) => !row.ok).map((row) => row.url);
    setInput(failed.join('\n'));
    setRetrying(true);
    setSummary(null);
    setError(null);
  };

  const successCount = summary?.filter((row) => row.ok).length ?? 0;
  const failedCount = summary === null ? 0 : summary.length - successCount;

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to={backTo} className={backLink}>
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
            onClick={() => navigate(backTo)}
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
            onChange={(e) => {
              setInput(e.target.value);
              setRetrying(false);
              setBatchDestination(undefined);
            }}
            rows={5}
            readOnly={busy || pendingUrls !== null}
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
              disabled={busy || pendingUrls !== null}
              onChange={(e) => {
                setBulk(e.target.checked);
                setRetrying(false);
                setBatchDestination(undefined);
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
          {collections === undefined && <p role="status">Loading collections…</p>}
          <button
            type="button"
            onClick={() => void extract()}
            disabled={busy || pendingUrls !== null || collections === undefined || input.trim() === ''}
            aria-busy={busy || undefined}
            className={`${primaryBtn} mt-3 inline-flex w-full items-center justify-center gap-2 py-3`}
            style={{ opacity: busy ? 1 : undefined }}
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

          <CreateRecipeForm
            initial={preview}
            collectionId={collectionId}
            onCreated={(recipe) => navigate(`/recipe/${recipe.id}`, { replace: true })}
            onCancel={() => setPreview(null)}
          />
        </>
      )}
      {pendingUrls && (
        <SaveToCollectionSheet
          title="Import recipes to"
          createLabel="Create and import"
          onSave={(id) => runBulk(pendingUrls, id)}
          onCancel={() => setPendingUrls(null)}
        />
      )}
    </div>
  );
}
