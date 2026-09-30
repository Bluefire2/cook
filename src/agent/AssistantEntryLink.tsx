import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { ghostBtn } from '../lib/uiClasses';

/** Chat bubble, drawn like the header cog. A word here wrapped the header in uk and ru. */
function AskIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

export default function AssistantEntryLink() {
  const tr = useT();
  return (
    <Link
      to="/assistant"
      className={`${ghostBtn} inline-flex items-center justify-center px-2 py-2`}
      aria-label={tr('assistant.ask')}
    >
      <AskIcon className="block h-5 w-5" />
    </Link>
  );
}
