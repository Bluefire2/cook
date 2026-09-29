import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { ghostBtn } from '../lib/uiClasses';

export default function AssistantEntryLink() {
  const tr = useT();
  return (
    <Link to="/assistant" className={ghostBtn}>
      {tr('assistant.ask')}
    </Link>
  );
}
