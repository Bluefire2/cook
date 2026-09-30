import { t } from '../i18n';

/**
 * A 401/403 from the server. `remote` has already cleared the library by the
 * time a store sees it, so a rollback must write nothing back. The message is
 * the usual sign-in prompt; the type lets a rollback tell sign-out apart
 * without reading the text.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super(t('error.sessionExpired'));
  }
}
