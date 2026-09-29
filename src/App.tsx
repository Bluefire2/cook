import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import SyncToast from './components/SyncToast';
import { importHref, libraryHref, newRecipeHref } from './lib/collectionStore';
import Library from './screens/Library';
import RecipeView from './screens/RecipeView';
import RecipeEdit from './screens/RecipeEdit';
import CookLogEdit from './screens/CookLogEdit';
import CookJournal from './screens/CookJournal';
import ImportScreen from './screens/ImportScreen';
import Settings from './screens/Settings';
import Admin from './screens/Admin';

function WithLegacyCollectionRedirect({
  href,
  children,
}: {
  href: (collectionId: string | undefined) => string;
  children: ReactNode;
}) {
  const [params] = useSearchParams();
  const legacy = params.get('c');
  if (legacy !== null) {
    return <Navigate to={href(legacy)} replace />;
  }
  return children;
}

function LibraryAtRoot() {
  return (
    <WithLegacyCollectionRedirect href={libraryHref}>
      <Library />
    </WithLegacyCollectionRedirect>
  );
}

function ImportAtRoot() {
  return (
    <WithLegacyCollectionRedirect href={importHref}>
      <ImportScreen />
    </WithLegacyCollectionRedirect>
  );
}

function NewRecipeAtRoot() {
  return (
    <WithLegacyCollectionRedirect href={newRecipeHref}>
      <RecipeEdit />
    </WithLegacyCollectionRedirect>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <SyncToast />
      <Routes>
        <Route path="/" element={<LibraryAtRoot />} />
        <Route path="/collections" element={<Navigate to="/" replace />} />
        <Route path="/collections/:collectionId/import" element={<ImportScreen />} />
        <Route
          path="/collections/:collectionId/recipe/new"
          element={<RecipeEdit />}
        />
        <Route path="/collections/:collectionId" element={<Library />} />
        <Route path="/recipe/new" element={<NewRecipeAtRoot />} />
        <Route path="/recipe/:id" element={<RecipeView />} />
        <Route path="/recipe/:id/edit" element={<RecipeEdit />} />
        <Route path="/recipe/:id/cooks/new" element={<CookLogEdit />} />
        <Route path="/recipe/:id/cooks/:logId/edit" element={<CookLogEdit />} />
        <Route path="/cooks" element={<CookJournal />} />
        <Route path="/import" element={<ImportAtRoot />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </ErrorBoundary>
  );
}
