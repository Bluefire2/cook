import { useState } from 'react';
import { Link } from 'react-router-dom';
import { settings } from '../lib/settings';

export default function Settings() {
  const [password, setPassword] = useState(settings.getPassword());
  const [saved, setSaved] = useState(false);

  return (
    <div className="mx-auto max-w-xl px-4 pb-24">
      <header className="py-4">
        <Link to="/" className="text-sm text-stone-500">
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-bold">Settings</h1>
      </header>

      <label className="block">
        <span className="text-sm font-medium text-stone-600">App password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setSaved(false);
          }}
          placeholder="Password for the assistant API"
          className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-4 py-2.5 shadow-sm outline-none focus:border-stone-400"
        />
      </label>
      <p className="mt-1.5 text-sm text-stone-500">
        Must match the APP_PASSWORD configured on the server. Stored only on
        this device.
      </p>
      <button
        type="button"
        onClick={() => {
          settings.setPassword(password);
          setSaved(true);
        }}
        className="mt-3 rounded-full bg-stone-800 px-5 py-2 font-medium text-white"
      >
        {saved ? 'Saved ✓' : 'Save'}
      </button>
    </div>
  );
}
