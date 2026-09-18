import { Route, Routes } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import AccountGate from './components/AccountGate';
import SyncToast from './components/SyncToast';
import Library from './screens/Library';
import RecipeView from './screens/RecipeView';
import RecipeEdit from './screens/RecipeEdit';
import ImportScreen from './screens/ImportScreen';
import Settings from './screens/Settings';
import Admin from './screens/Admin';

export default function App() {
  return (
    <ErrorBoundary>
      <SyncToast />
      <AccountGate />
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/recipe/new" element={<RecipeEdit />} />
        <Route path="/recipe/:id" element={<RecipeView />} />
        <Route path="/recipe/:id/edit" element={<RecipeEdit />} />
        <Route path="/import" element={<ImportScreen />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </ErrorBoundary>
  );
}
