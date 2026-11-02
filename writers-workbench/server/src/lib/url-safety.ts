/**
 * SSRF guard for user-supplied URLs the server (or the engine) will call with a credential attached
 * — a blog channel's endpoint. Same rule as the engine's writer_engine/url_safety.py:
 *
 *  - https only, no user:password in the URL;
 *  - the host must resolve, and every address it resolves to must be public — not private,
 *    loopback, link-local (cloud metadata lives at 169.254.169.254), CGNAT, multicast, reserved,
 *    unspecified, or an IPv4 address wrapped in IPv6.
 *
 * `safeHttpsRequest` re-checks the address the socket actually connects to (a custom `lookup`),
 * so a DNS answer that changes between the check and the request (rebinding) is still refused,
 * and it never follows redirects.
 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata']);

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0];
  // Trailing dotted IPv4 (::ffff:1.2.3.4)
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (!net.isIPv4(v4[1])) return null;
    const n = v4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPublicIp(address: string): boolean {
  if (net.isIPv4(address)) return !V4_BLOCKED.some(([base, bits]) => inV4(address, base, bits));
  if (!net.isIPv6(address.split('%')[0])) return false;
  const g = expandV6(address);
  if (!g) return false;
  const embedded = (hi: number, lo: number): string => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::/96 (NAT64)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return false; // :: and ::1
    return isPublicIp(embedded(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicIp(embedded(g[6], g[7]));
  if (g[0] === 0x2002) return isPublicIp(embedded(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  return (g[0] & 0xe000) === 0x2000; // global unicast 2000::/3 only
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolve: Resolver = async (host) =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** null when `raw` is a safe https URL to call; otherwise a reason a user can read. */
export async function checkPublicHttpsUrl(raw: string, resolve: Resolver = systemResolve): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:') return 'the URL must start with https://';
  if (url.username || url.password) return 'the URL must not contain a username or password';
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return 'the URL has no host';
  if (BLOCKED_HOSTS.has(host) || /\.(localhost|internal|local)$/.test(host)) return `${host} is not a public host`;
  if (net.isIP(host)) return isPublicIp(host) ? null : `${host} is not a public address`;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return `${host} does not resolve`;
  }
  if (!addresses.length) return `${host} does not resolve`;
  if (addresses.some((a) => !isPublicIp(a))) return `${host} resolves to a non-public address`;
  return null;
}

/** A dns.lookup that refuses non-public answers — used for the socket itself (anti-rebinding). */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, '', 0);
    const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
    const bad = list.find((a) => !isPublicIp(a.address));
    if (!list.length || bad) {
      const e = Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'ESSRF' });
      return (callback as (e: Error | null, a: string, f: number) => void)(e, '', 0);
    }
    if ((options as dns.LookupOptions)?.all) {
      return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    }
    return (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

export interface SafeResponse {
  status: number;
  location: string | null;
  /** The body, capped. Never returned to a browser as-is: it may echo the request's headers. */
  body: string;
}

/**
 * One https request with SSRF protection on the actual connection, no redirects, a timeout, and a
 * capped body. Throws on network errors.
 */
export function safeHttpsRequest(
  rawUrl: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeResponse> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') return Promise.reject(new Error('the URL must start with https://'));
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: { 'User-Agent': 'WritersWorkbench-Integrations/1', ...(opts.headers ?? {}) },
        lookup: publicOnlyLookup,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : null,
            body: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
