import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLocale, useT } from '../i18n';
import { unitLabel } from '../i18n/unitLabel';
import ChatPanel from '../components/ChatPanel';
import CookLogCard from '../components/CookLogCard';
import { useCookLogs } from '../lib/cookLogStore';
import { usePhotoUrl } from '../lib/photoStore';
import { recipeStore, useRecipe } from '../lib/recipeStore';
import { formatQuantity } from '../lib/quantity';
import { sync } from '../lib/syncEngine';
import { backLink, ghostBtn, secondaryBtn } from '../lib/uiClasses';
import { useWakeLock } from '../lib/useWakeLock';
import { useCookState } from '../lib/useCookState';
import type { Ingredient } from '../lib/types';
import type { Locale } from '../i18n';

/**
 * The source is whatever the user pasted on import, so it is only ever linked
 * after it turns out to be an ordinary web address.
 */
function sourceLink(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function ingredientLabel(
  ing: Ingredient,
  scale: number,
  locale: Locale,
  labelUnit: (token: string) => string,
): string {
  const parts = [
    ing.quantity !== undefined ? formatQuantity(ing.quantity * scale, locale) : null,
    ing.unit ? labelUnit(ing.unit) : null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

function GalleryImage({ photoId }: { photoId: string }) {
  const url = usePhotoUrl(photoId);
  return (
    <div className="overflow-hidden rounded-xl bg-surface-muted shadow-sm">
      {url && (
        <img src={url} alt="" className="aspect-square w-full object-cover" />
      )}
    </div>
  );
}

function SourceCredit({ source }: { source: URL }) {
  const t = useT();
  const label = t('recipe.source', { source: source.hostname });
  const at = label.indexOf(source.hostname);
  const link = (
    <a
      href={source.href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline hover:text-ink"
    >
      {source.hostname}
    </a>
  );
  if (at < 0) {
    return (
      <p className="mt-6 text-sm text-ink-muted">
        <a
          href={source.href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline hover:text-ink"
        >
          {label}
        </a>
      </p>
    );
  }
  return (
    <p className="mt-6 text-sm text-ink-muted">
      {label.slice(0, at)}
      {link}
      {label.slice(at + source.hostname.length)}
    </p>
  );
}

export default function RecipeView() {
  const t = useT();
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const recipe = useRecipe(id);
  const photoUrl = usePhotoUrl(recipe?.photoId);
  useWakeLock();

  const {
    servings,
    currentStep,
    checkedKeys,
    setServings,
    setCurrentStep,
    toggleChecked,
    checkedItemNames,
  } = useCookState(recipe);
  const [chatOpen, setChatOpen] = useState(false);
  const cookLogs = useCookLogs(recipe?.id) ?? [];

  /**
   * A link from the Chrome extension is the first this device hears of a recipe
   * that was saved on the server, so an id missing from the library means "pull
   * and see", not "gone". Settled is tracked as the id it settled for: React
   * Router reuses this element across an id change, and the neutral state has
   * to be the initial one or not-found paints for a frame first.
   */
  const [settledId, setSettledId] = useState<string | undefined>(undefined);
  const lookedUpId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (recipe !== null || id === undefined || lookedUpId.current === id) return;
    lookedUpId.current = id;
    void sync().finally(() => setSettledId(id));
  }, [recipe, id]);

  if (recipe === undefined) {
    return (
      <div className="p-6 text-center text-ink-muted">{t('common.loadingRecipe')}</div>
    );
  }
  if (recipe === null) {
    if (settledId !== id) {
      return (
        <div className="p-6 text-center text-ink-muted">{t('recipe.lookingFor')}</div>
      );
    }
    return (
      <div className="p-6 text-center text-ink-muted">
        {t('common.recipeNotFound')}{' '}
        <Link to="/" className="underline hover:text-ink">
          {t('common.backToLibrary')}
        </Link>
      </div>
    );
  }

  const shared = recipeStore.isShared(recipe.id);
  const scale = servings / recipe.servings;
  const source = sourceLink(recipe.sourceUrl);

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <div className="flex items-center justify-between">
          <Link to="/" className={backLink}>
            &larr; {t('common.library')}
          </Link>
          {!shared && (
            <Link to={`/recipe/${recipe.id}/edit`} className={ghostBtn}>
              {t('common.edit')}
            </Link>
          )}
        </div>
        {photoUrl && (
          <img
            src={photoUrl}
            alt=""
            className="mt-3 h-52 w-full rounded-2xl object-cover shadow-sm"
          />
        )}
        <h1 className="mt-2 text-2xl font-bold">{recipe.title}</h1>
        {recipe.description && (
          <p className="mt-1 text-ink-muted">{recipe.description}</p>
        )}
        <p className="mt-2 text-sm text-ink-muted">
          {recipe.prepMinutes != null &&
            t('recipe.prepMinutes', { count: recipe.prepMinutes })}
          {recipe.prepMinutes != null && recipe.cookMinutes != null && ' · '}
          {recipe.cookMinutes != null &&
            t('recipe.cookMinutes', { count: recipe.cookMinutes })}
        </p>
      </header>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('common.ingredients')}</h2>
          <div className="flex items-center gap-1 rounded-full border border-line bg-surface">
            <button
              type="button"
              aria-label={t('recipe.fewerServings')}
              disabled={servings <= 1}
              onClick={() => setServings(servings - 1)}
              className="h-9 w-9 rounded-full text-lg text-ink-muted hover:bg-surface-muted active:bg-surface-muted disabled:opacity-30"
            >
              −
            </button>
            <span className="min-w-16 text-center text-sm">
              {t('common.servingsCount', { count: servings })}
            </span>
            <button
              type="button"
              aria-label={t('recipe.moreServings')}
              onClick={() => setServings(servings + 1)}
              className="h-9 w-9 rounded-full text-lg text-ink-muted hover:bg-surface-muted active:bg-surface-muted"
            >
              +
            </button>
          </div>
        </div>

        {recipe.ingredientSections.map((section, si) => (
          <div key={si} className="mt-2">
            {section.name && (
              <h3 className="mt-3 text-sm font-medium tracking-wide text-ink-muted uppercase">
                {section.name}
              </h3>
            )}
            <ul className="mt-1 flex flex-col gap-1.5">
              {section.items.map((ing, ii) => {
                const key = `${si}-${ii}`;
                const isChecked = checkedKeys.has(key);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => toggleChecked(key)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left shadow-sm transition-colors ${
                        isChecked
                          ? 'bg-surface-muted text-ink-subtle hover:bg-surface active:bg-surface'
                          : 'bg-surface hover:bg-surface-muted active:bg-surface-muted'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                          isChecked
                            ? 'border-line-strong bg-ink-subtle text-page'
                            : 'border-line-strong'
                        }`}
                      >
                        {isChecked ? '✓' : ''}
                      </span>
                      <span className={isChecked ? 'line-through' : ''}>
                        {ingredientLabel(ing, scale, locale, (token) => unitLabel(token, t))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">{t('common.steps')}</h2>
        <ol className="mt-2 flex flex-col gap-2">
          {recipe.steps.map((step, i) => {
            const isCurrent = i === currentStep;
            const isDone = i < currentStep;
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setCurrentStep(i === currentStep ? i + 1 : i)}
                  className={`flex w-full gap-3 rounded-xl px-3 py-3 text-left shadow-sm transition-colors ${
                    isCurrent
                      ? 'bg-surface ring-2 ring-amber-400'
                      : isDone
                        ? 'bg-surface-muted text-ink-subtle'
                        : 'bg-surface hover:bg-surface-muted active:bg-surface-muted'
                  }`}
                >
                  <span
                    className={`font-semibold ${
                      isCurrent ? 'text-amber-500' : 'text-ink-subtle'
                    }`}
                  >
                    {isDone ? '✓' : i + 1}
                  </span>
                  <span className={isCurrent ? 'text-lg' : ''}>{step.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {currentStep >= recipe.steps.length && (
          <div className="mt-4 text-center">
            <p className="font-medium text-amber-600">{t('recipe.doneEnjoy')}</p>
            {!shared && (
              <Link
                to={`/recipe/${recipe.id}/cooks/new`}
                className={`${secondaryBtn} mt-3 inline-block px-5 py-2`}
              >
                {t('recipe.logThisCook')}
              </Link>
            )}
          </div>
        )}
      </section>

      {recipe.notes && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">{t('common.notes')}</h2>
          <p className="mt-2 rounded-lg bg-surface px-3 py-3 whitespace-pre-line text-ink-muted shadow-sm">
            {recipe.notes}
          </p>
        </section>
      )}

      {recipe.galleryPhotoIds && recipe.galleryPhotoIds.length > 0 && (
        <section className="mt-6 grid grid-cols-2 gap-2">
          {recipe.galleryPhotoIds.map((id) => (
            <GalleryImage key={id} photoId={id} />
          ))}
        </section>
      )}

      {!shared && (
        <section className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {t('recipe.yourCooks')}
              {cookLogs.length > 0 && (
                <span className="ml-2 font-normal text-ink-subtle">{cookLogs.length}</span>
              )}
            </h2>
            <Link to={`/recipe/${recipe.id}/cooks/new`} className={ghostBtn}>
              {t('recipe.logACook')}
            </Link>
          </div>
          {cookLogs.length > 0 && (
            <ul className="mt-2 flex flex-col gap-3">
              {cookLogs.map((log) => (
                <li key={log.id}>
                  <CookLogCard log={log} recipe={recipe} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {source && (
        <SourceCredit source={source} />
      )}

      {!chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="fixed right-5 bottom-8 z-10 flex h-14 items-center gap-2 rounded-full bg-amber-500 px-5 font-medium text-white shadow-lg hover:bg-amber-600 active:bg-amber-600"
        >
          {t('recipe.ask')}
        </button>
      )}
      {chatOpen && (
        <ChatPanel
          recipe={recipe}
          readOnly={shared}
          cookingState={{
            servings,
            currentStep: currentStep + 1,
            checkedIngredients: checkedItemNames(recipe),
          }}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  );
}
