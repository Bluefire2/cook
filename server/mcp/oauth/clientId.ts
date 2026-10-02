/**
 * Client ID Metadata Document URLs, redirect URIs, and which addresses Sous
 * may fetch a metadata document from. Pure: `isPublicAddress` decides on an
 * address that `clientMetadata.ts` resolved; nothing here does I/O.
 */
import { BlockList, isIP } from 'node:net';
import { MAX_CLIENT_ID_CHARS, MAX_REDIRECT_URI_CHARS } from '../config.ts';

const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A `client_id` Sous will fetch: an `https` URL with a path below the root,
 * no fragment, query, or userinfo, the default port, and a DNS name rather
 * than an IP literal. It must already be in canonical form, because the
 * document's own `client_id` is compared with it as a string.
 */
export function parseClientIdUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_CLIENT_ID_CHARS) {
    return null;
  }
  if (raw.includes('#') || raw.includes('?') || raw.includes('@')) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.href !== raw) {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return null;
  }
  if (url.pathname === '/' || url.pathname === '') {
    return null;
  }
  const host = url.hostname;
  if (host.startsWith('[') || IPV4_LITERAL_RE.test(host) || isIP(host) !== 0) {
    return null;
  }
  // A single-label name (`localhost`, an intranet host) is never a public client.
  if (!host.includes('.')) {
    return null;
  }
  return url;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** `http` to `127.0.0.1`, `[::1]`, or `localhost`: an app running on the person's own computer. */
export function isLoopbackRedirect(raw: string): boolean {
  const url = parseUrl(raw);
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** A redirect URI a client document may list: `https`, or an `http` loopback. Never a fragment. */
export function redirectUriShapeAllowed(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_REDIRECT_URI_CHARS) {
    return false;
  }
  const url = parseUrl(raw);
  if (url === null || raw.includes('#') || url.username !== '' || url.password !== '') {
    return false;
  }
  return url.protocol === 'https:' || isLoopbackRedirect(raw);
}

/**
 * Whether `requested` is one of the document's `registered` redirect URIs:
 * exact string equality, except that a loopback URI matches with its port
 * ignored (RFC 8252 §7.3, applied to `localhost` as well because Claude
 * Code registers `http://localhost/callback`). Host, path, and query must
 * still match.
 */
export function redirectUriAllowed(requested: string, registered: readonly string[]): boolean {
  if (!redirectUriShapeAllowed(requested)) {
    return false;
  }
  if (registered.includes(requested)) {
    return true;
  }
  if (!isLoopbackRedirect(requested)) {
    return false;
  }
  const want = parseUrl(requested);
  if (want === null) {
    return false;
  }
  return registered.some((entry) => {
    if (!isLoopbackRedirect(entry)) {
      return false;
    }
    const have = parseUrl(entry);
    return (
      have !== null &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/**
 * Everything Sous must never connect to on a client's say-so: loopback,
 * private, link-local (including the metadata server at 169.254.169.254),
 * CGNAT, unique local, multicast, unspecified, documentation and other
 * special ranges, and any IPv6 form that embeds an IPv4 address (mapped,
 * NAT64, 6to4, Teredo), since the embedded address could be any of those.
 */
// Two lists: BlockList matches an IPv4 address against IPv4-mapped IPv6
// rules, so `::ffff:0:0/96` in a shared list would block every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !BLOCKED_V4.check(address, 'ipv4');
  }
  if (family === 6) {
    return !BLOCKED_V6.check(address, 'ipv6');
  }
  return false;
}
