import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { languageName, sameLanguage, useLocale, useT } from '../i18n';
import { unitLabel } from '../i18n/unitLabel';
import ChatPanel from '../components/ChatPanel';
import CookLogCard from '../components/CookLogCard';
import { useCookLogs } from '../lib/cookLogStore';
import { SpinnerIcon } from '../lib/icons';
import { usePhotoUrl } from '../lib/photoStore';
import { recipeStore, useRecipe } from '../lib/recipeStore';
import { formatQuantity } from '../lib/quantity';
import { sync } from '../lib/syncEngine';
import { translateChipMode, type TranslateChipMode } from '../lib/translateChip';
import {
  displayRecipe as recipeForDisplay,
  effectiveRecipeLang,
  getDetectedLang,
  showOriginal,
  translateRecipe,
} from '../lib/translationStore';
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

function TranslateChip({
  mode,
  label,
  onTranslate,
  onOriginal,
}: {
  mode: Exclude<TranslateChipMode, 'hidden'>;
  label: string;
  onTranslate: () => void;
  onOriginal: () => void;
}) {
  if (mode === 'loading') {
    return (
      <button
        type="button"
        disabled
        aria-busy="true"
        aria-label={label}
        className={`${ghostBtn} inline-flex items-center`}
      >
        <SpinnerIcon className="h-4 w-4 animate-spin" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={mode === 'translated' ? onOriginal : onTranslate}
      className={`${ghostBtn} inline-flex items-center${mode === 'unlabelled' ? ' opacity-70' : ''}`}
    >
      {label}
    </button>
  );
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
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<{
    id: string;
    updatedAt: number;
    phase: 'loading' | 'error';
  } | null>(null);
  const [alreadyNotice, setAlreadyNotice] = useState<{
    id: string;
    updatedAt: number;
    locale: Locale;
  } | null>(null);
  const requestSerial = useRef(0);
  const displayBody = useMemo(
    () => (recipe == null ? recipe : recipeForDisplay(recipe, locale)),
    [recipe, locale, revision],
  );
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
  const canEdit = !shared || recipeStore.access(recipe.id) === 'editor';
  const scale = servings / recipe.servings;
  const source = sourceLink(recipe.sourceUrl);
  // A translation must not flow into chat or save, or it would overwrite the original (principle 1).
  const displayRecipe = displayBody ?? recipe;
  const effective = effectiveRecipeLang(recipe);
  const phase =
    pending !== null && pending.id === recipe.id && pending.updatedAt === recipe.updatedAt
      ? pending.phase
      : undefined;
  const mode = translateChipMode({
    effectiveLang: effective,
    uiLang: locale,
    viewingTranslation: displayRecipe !== recipe,
    pending: phase,
  });
  const uiLanguage = languageName(locale, locale) ?? locale;
  const sourceLanguage =
    effective !== undefined
      ? (languageName(effective, locale) ?? effective)
      : t('langPicker.unknown');
  const showAlready =
    mode === 'hidden' &&
    alreadyNotice !== null &&
    alreadyNotice.id === recipe.id &&
    alreadyNotice.updatedAt === recipe.updatedAt &&
    alreadyNotice.locale === locale;
  const hasTime = recipe.prepMinutes != null || recipe.cookMinutes != null;

  const onTranslate = () => {
    const id = recipe.id;
    const updatedAt = recipe.updatedAt;
    const target = locale;
    const serial = ++requestSerial.current;
    setPending({ id, updatedAt, phase: 'loading' });
    void translateRecipe(recipe, target)
      .then(() => {
        if (serial !== requestSerial.current) return;
        const detected = getDetectedLang(id, updatedAt);
        if (sameLanguage(detected, target) === 'same') {
          showOriginal(id);
          setAlreadyNotice({ id, updatedAt, locale: target });
        }
        setPending((current) =>
          current !== null && current.id === id && current.updatedAt === updatedAt ? null : current,
        );
        setRevision((n) => n + 1);
      })
      .catch(() => {
        if (serial !== requestSerial.current) return;
        setPending({ id, updatedAt, phase: 'error' });
      });
  };

  const onOriginal = () => {
    showOriginal(recipe.id);
    setPending((current) =>
      current !== null && current.id === recipe.id && current.updatedAt === recipe.updatedAt
        ? null
        : current,
    );
    setRevision((n) => n + 1);
  };

  const chipLabel =
    mode === 'labelled'
      ? t('recipe.translateLabelled', { language: sourceLanguage })
      : mode === 'unlabelled'
        ? t('recipe.translate')
        : mode === 'loading'
          ? t('recipe.translating')
          : mode === 'translated'
            ? t('recipe.translatedFrom', { language: sourceLanguage })
            : mode === 'error'
              ? t('recipe.translateRetry')
              : '';

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <div className="flex items-center justify-between">
          <Link to="/" className={backLink}>
            &larr; {t('common.library')}
          </Link>
          {canEdit && (
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
        <h1 className="mt-2 text-2xl font-bold">{displayRecipe.title}</h1>
        {displayRecipe.description && (
          <p className="mt-1 text-ink-muted">{displayRecipe.description}</p>
        )}
        {(hasTime || mode !== 'hidden') && (
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-ink-muted">
            {recipe.prepMinutes != null && (
              <span>{t('recipe.prepMinutes', { count: recipe.prepMinutes })}</span>
            )}
            {recipe.prepMinutes != null && recipe.cookMinutes != null && (
              <span aria-hidden="true">·</span>
            )}
            {recipe.cookMinutes != null && (
              <span>{t('recipe.cookMinutes', { count: recipe.cookMinutes })}</span>
            )}
            {hasTime && mode !== 'hidden' && <span aria-hidden="true">·</span>}
            {mode !== 'hidden' && (
              <TranslateChip
                mode={mode}
                label={chipLabel}
                onTranslate={onTranslate}
                onOriginal={onOriginal}
              />
            )}
          </p>
        )}
        {showAlready && (
          <p
            className="mt-3 rounded-2xl border border-line bg-accent-soft px-4 py-3 text-sm text-ink"
            role="status"
          >
            {t('recipe.alreadyInLanguage', { language: uiLanguage })}
          </p>
        )}
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

        {recipe.ingredientSections.map((section, si) => {
          const translatedSection = displayRecipe.ingredientSections[si];
          const sectionName = (translatedSection ?? section).name;
          return (
            <div key={si} className="mt-2">
              {sectionName && (
                <h3 className="mt-3 text-sm font-medium tracking-wide text-ink-muted uppercase">
                  {sectionName}
                </h3>
              )}
              <ul className="mt-1 flex flex-col gap-1.5">
                {section.items.map((ing, ii) => {
                  // Checkoff identity is the stored row index, so translated text cannot uncheck it.
                  const key = `${si}-${ii}`;
                  const isChecked = checkedKeys.has(key);
                  const translatedItem = translatedSection?.items[ii];
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
                          {ingredientLabel(
                            { ...(translatedItem ?? ing), quantity: ing.quantity },
                            scale,
                            locale,
                            (token) => unitLabel(token, t),
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">{t('common.steps')}</h2>
        <ol className="mt-2 flex flex-col gap-2">
          {recipe.steps.map((step, i) => {
            const isCurrent = i === currentStep;
            const isDone = i < currentStep;
            const text = displayRecipe.steps[i]?.text ?? step.text;
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
                  <span className={isCurrent ? 'text-lg' : ''}>{text}</span>
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

      {displayRecipe.notes && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">{t('common.notes')}</h2>
          <p className="mt-2 rounded-lg bg-surface px-3 py-3 whitespace-pre-line text-ink-muted shadow-sm">
            {displayRecipe.notes}
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
          allowApply={canEdit}
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
