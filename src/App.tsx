import { Navigate, Route, Routes } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import SyncToast from './components/SyncToast';
import { routePaths } from './lib/routePaths';
import Library from './screens/Library';
import RecipeView from './screens/RecipeView';
import RecipeEdit from './screens/RecipeEdit';
import CookLogEdit from './screens/CookLogEdit';
import CookJournal from './screens/CookJournal';
import ImportScreen from './screens/ImportScreen';
import Settings from './screens/Settings';
import Admin from './screens/Admin';
import { AssistantScreen } from './agent/index';

function AppRoutes() {
  return (
    <Routes>
      {/* One Library instance serves both list paths, so it stays mounted across chip changes. */}
      <Route element={<Library />}>
        <Route path={routePaths.home} element={null} />
        <Route path={routePaths.collection} element={null} />
      </Route>
      <Route path={routePaths.collectionsIndex} element={<Navigate to="/" replace />} />
      <Route path={routePaths.collectionsUnknown} element={<Navigate to="/" replace />} />
      <Route path={routePaths.collectionImport} element={<ImportScreen />} />
      <Route
        path={routePaths.collectionNewRecipe}
        element={<RecipeEdit />}
      />
      <Route path={routePaths.newRecipe} element={<RecipeEdit />} />
      <Route path="/recipe/:id" element={<RecipeView />} />
      <Route path="/recipe/:id/edit" element={<RecipeEdit />} />
      <Route path="/recipe/:id/cooks/new" element={<CookLogEdit />} />
      <Route path="/recipe/:id/cooks/:logId/edit" element={<CookLogEdit />} />
      <Route path="/cooks" element={<CookJournal />} />
      <Route path={routePaths.import} element={<ImportScreen />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/assistant" element={<AssistantScreen />} />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <SyncToast />
      <AppRoutes />
    </ErrorBoundary>
  );
}
