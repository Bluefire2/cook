import { Link } from 'react-router-dom';

export default function ImportScreen() {
  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className="text-sm text-stone-500">
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Import recipe</h1>
      </header>
      <p className="text-stone-500">
        Coming soon: paste a link or recipe text and the assistant will turn it
        into a recipe.
      </p>
    </div>
  );
}
