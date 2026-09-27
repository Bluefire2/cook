import { Link } from 'react-router-dom';
import { ghostBtn } from '../lib/uiClasses';

export default function AssistantEntryLink() {
  return (
    <Link to="/assistant" className={ghostBtn}>
      Ask
    </Link>
  );
}
