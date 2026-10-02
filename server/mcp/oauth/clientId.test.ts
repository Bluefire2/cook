import { describe, expect, it } from 'vitest';
import {
  isLoopbackRedirect,
  isPublicAddress,
  parseClientIdUrl,
  redirectUriAllowed,
  redirectUriShapeAllowed,
} from './clientId.ts';

describe('parseClientIdUrl', () => {
  it('accepts the Claude client metadata URLs', () => {
    expect(parseClientIdUrl('https://claude.ai/oauth/claude-code-client-metadata')?.hostname).toBe('claude.ai');
    expect(parseClientIdUrl('https://claude.ai/oauth/mcp-oauth-client-metadata')).not.toBeNull();
  });

  it('rejects http, a root path, a fragment, a query, userinfo, an IP literal, or a non-default port', () => {
    for (const raw of [
      'http://claude.ai/oauth/client',
      'https://claude.ai/',
      'https://claude.ai',
      'https://claude.ai/oauth/client#x',
      'https://claude.ai/oauth/client#',
      'https://claude.ai/oauth/client?x=1',
      'https://user@claude.ai/oauth/client',
      'https://user:pw@claude.ai/oauth/client',
      'https://93.184.216.34/client',
      'https://[2606:2800:220:1::]/client',
      'https://claude.ai:8443/oauth/client',
      'https://localhost/client',
      'https://CLAUDE.ai/oauth/client',
      'not a url',
      `https://claude.ai/${'x'.repeat(600)}`,
      42,
    ]) {
      expect(parseClientIdUrl(raw), String(raw)).toBeNull();
    }
  });
});

describe('redirect URIs', () => {
  const claudeCode = ['http://localhost/callback', 'http://127.0.0.1/callback'];

  it('matches loopback redirects with the port ignored', () => {
    expect(redirectUriAllowed('http://localhost:3118/callback', claudeCode)).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1:5555/callback', claudeCode)).toBe(true);
    expect(redirectUriAllowed('http://localhost/callback', claudeCode)).toBe(true);
  });

  it('rejects a path, host, query, or scheme change on a loopback redirect', () => {
    expect(redirectUriAllowed('http://localhost:3118/other', claudeCode)).toBe(false);
    expect(redirectUriAllowed('http://localhost:3118/callback?x=1', claudeCode)).toBe(false);
    expect(redirectUriAllowed('https://localhost:3118/callback', claudeCode)).toBe(false);
    expect(redirectUriAllowed('http://[::1]:3118/callback', claudeCode)).toBe(false);
    expect(redirectUriAllowed('http://evil.example/callback', claudeCode)).toBe(false);
  });

  it('is exact for https', () => {
    const hosted = ['https://claude.ai/api/mcp/auth_callback'];
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', hosted)).toBe(true);
    expect(redirectUriAllowed('https://claude.ai:443/api/mcp/auth_callback', hosted)).toBe(false);
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback/', hosted)).toBe(false);
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback?x', hosted)).toBe(false);
  });

  it('allows https or http loopback in a document, never other http or a fragment', () => {
    expect(redirectUriShapeAllowed('https://app.example/cb')).toBe(true);
    expect(redirectUriShapeAllowed('http://[::1]/cb')).toBe(true);
    expect(redirectUriShapeAllowed('http://app.example/cb')).toBe(false);
    expect(redirectUriShapeAllowed('https://app.example/cb#frag')).toBe(false);
    expect(redirectUriShapeAllowed('myapp://cb')).toBe(false);
    expect(isLoopbackRedirect('http://127.0.0.1:9/cb')).toBe(true);
    expect(isLoopbackRedirect('https://127.0.0.1/cb')).toBe(false);
  });
});

describe('isPublicAddress', () => {
  it('accepts ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '160.79.104.10', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('rejects every private and special range', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '127.255.255.255',
      '169.254.169.254',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      '2001::1',
      '2001:db8::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
      'not-an-ip',
      '',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('keeps addresses just outside a range public', () => {
    expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('100.128.0.1')).toBe(true);
    expect(isPublicAddress('11.0.0.1')).toBe(true);
  });
});
