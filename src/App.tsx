import { Navigate, Route, Routes } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import SyncToast from './components/SyncToast';
import Library from './screens/Library';
import RecipeView from './screens/RecipeView';
import RecipeEdit from './screens/RecipeEdit';
import CookLogEdit from './screens/CookLogEdit';
import CookJournal from './screens/CookJournal';
import ImportScreen from './screens/ImportScreen';
import Settings from './screens/Settings';
import Admin from './screens/Admin';

function LibraryLeaf() {
  return null;
}

function LibraryLayout() {
  return <Library />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <SyncToast />
      <Routes>
        <Route element={<LibraryLayout />}>
          <Route index element={<LibraryLeaf />} />
          <Route path="collections/:collectionId" element={<LibraryLeaf />} />
        </Route>
        <Route path="/collections" element={<Navigate to="/" replace />} />
        <Route path="/collections/*" element={<Navigate to="/" replace />} />
        <Route path="/collections/:collectionId/import" element={<ImportScreen />} />
        <Route
          path="/collections/:collectionId/recipe/new"
          element={<RecipeEdit />}
        />
        <Route path="/recipe/new" element={<RecipeEdit />} />
        <Route path="/recipe/:id" element={<RecipeView />} />
        <Route path="/recipe/:id/edit" element={<RecipeEdit />} />
        <Route path="/recipe/:id/cooks/new" element={<CookLogEdit />} />
        <Route path="/recipe/:id/cooks/:logId/edit" element={<CookLogEdit />} />
        <Route path="/cooks" element={<CookJournal />} />
        <Route path="/import" element={<ImportScreen />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </ErrorBoundary>
  );
}
