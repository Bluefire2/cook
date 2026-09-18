import { describe, expect, it } from 'vitest';
import { escapeHtml, invitationOnlyPage, unavailablePageHtml } from './access.ts';

describe('escapeHtml', () => {
  it('escapes HTML-sensitive characters', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes each vector independently', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes ampersands first, so existing entities are neutralised', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves safe text untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
    expect(escapeHtml('')).toBe('');
  });
});

describe('invitationOnlyPage', () => {
  it('names the signed-in address and posts the token as a hidden field', () => {
    const html = invitationOnlyPage({ email: 'person@example.com' }, 'tok.en-value');
    expect(html).toContain('<h1>Sous is invitation-only</h1>');
    expect(html).toContain('You signed in as person@example.com.');
    expect(html).toContain('<form method="POST" action="/api/access-request">');
    expect(html).toContain('<input type="hidden" name="t" value="tok.en-value">');
    expect(html).toContain('<button type="submit">Request access</button>');
    expect(html).toContain('Your request goes to the owner of this app.');
    expect(html).toContain('Nobody will email you back');
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect(html).toContain('<a href="/terms">Terms</a>');
  });

  it('renders a markup-looking display name as text, not markup', () => {
    const html = invitationOnlyPage(
      { email: 'person@example.com', name: '<b>x</b>' },
      'tok',
    );
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('escapes the token in the attribute context', () => {
    const html = invitationOnlyPage({ email: 'a@b.c' }, '"><script>');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain('<script>');
  });

  it('omits the form but keeps the guidance when the token could not be minted', () => {
    const html = invitationOnlyPage({ email: 'person@example.com' }, null);
    expect(html).toContain('<h1>Sous is invitation-only</h1>');
    expect(html).toContain('You signed in as person@example.com.');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('name="t"');
    expect(html).not.toContain('<button');
    // D14 substance survives the missing form: no email back, sign in again
    // once approved — plus the transient-failure pointer to retry sign-in.
    expect(html).toContain('could not be started right now');
    expect(html).toContain('Nobody will email you back');
    expect(html).toContain('once you have been approved, you can try signing in again');
  });

  it('is self-contained: lang, viewport, color-scheme, no script, no external URLs', () => {
    const html = invitationOnlyPage({ email: 'person@example.com' }, 'tok');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('color-scheme: light dark');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe('unavailablePageHtml', () => {
  it('tells the person sign-in is temporarily unavailable', () => {
    const html = unavailablePageHtml();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Sign-in is temporarily unavailable.');
    expect(html).not.toContain('<script');
  });
});
