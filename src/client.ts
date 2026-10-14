// Minimal read-only REST client for Jira and Confluence — both Server/DC and Cloud (*.atlassian.net).
// Auth is chosen per service:
//   bearer — Server/DC Personal Access Token: `Authorization: Bearer <PAT>`;
//   basic  — Atlassian Cloud API token: `Authorization: Basic base64(email:token)`.
// The token is never logged. On 401 / CAPTCHA we stop at once, without retries —
// otherwise the server enables CAPTCHA and blocks REST access until a browser login.

import { envHint } from './paths.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, message: string) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

export type AuthMode = 'bearer' | 'basic';

export interface ServiceConfig {
  /** Service name for error messages */
  label: string;
  baseUrl: string;
  token: string;
  auth: AuthMode;
  /** basic only: Atlassian account email */
  email?: string;
  /** Atlassian Cloud (*.atlassian.net or ATLASSIAN_CLOUD=1): different search API, user ids, /wiki */
  cloud: boolean;
}

let tlsConfigured = false;

function configureTls() {
  if (tlsConfigured) return;
  tlsConfigured = true;
  if (process.env.JIRA_INSECURE_TLS !== '1') return;
  // For self-hosted servers whose certificate chain ends in a corporate root CA missing from the OS store.
  // TLS verification is disabled only for this process and only with the explicit flag; Node's standard warning
  // is muted so it does not clutter every run.
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (String(warning).includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;
    emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const env = (name: string) => process.env[name]?.trim() || undefined;

/**
 * <PREFIX>_BASE_URL, <PREFIX>_TOKEN (or the shared ATLASSIAN_API_TOKEN), <PREFIX>_EMAIL (or ATLASSIAN_EMAIL),
 * <PREFIX>_AUTH = bearer | basic (default: basic if an email is set, otherwise bearer).
 */
function loadService(label: string, prefix: 'JIRA' | 'CONFLUENCE'): ServiceConfig | undefined {
  const baseUrl = env(`${prefix}_BASE_URL`)?.replace(/\/+$/, '');
  const token = env(`${prefix}_TOKEN`) ?? env('ATLASSIAN_API_TOKEN');
  if (!baseUrl || !token) return undefined;
  const email = env(`${prefix}_EMAIL`) ?? env('ATLASSIAN_EMAIL');
  const explicit = env(`${prefix}_AUTH`)?.toLowerCase();
  if (explicit && explicit !== 'bearer' && explicit !== 'basic') {
    throw new Error(`${prefix}_AUTH must be bearer or basic, not "${explicit}".`);
  }
  const auth: AuthMode = (explicit as AuthMode | undefined) ?? (email ? 'basic' : 'bearer');
  if (auth === 'basic' && !email) {
    throw new Error(`${label}: basic auth needs an email — set ${prefix}_EMAIL or ATLASSIAN_EMAIL.`);
  }
  // The URL is used exactly as given (Confluence Cloud includes /wiki). Cloud only selects the search API.
  const cloud = env('ATLASSIAN_CLOUD') === '1' || new URL(baseUrl).hostname.endsWith('.atlassian.net');
  configureTls();
  return { label, baseUrl, token, auth, email: auth === 'basic' ? email : undefined, cloud };
}

export function loadJiraConfig(): ServiceConfig {
  const config = loadService('Jira', 'JIRA');
  if (!config) throw new Error(`JIRA_BASE_URL / JIRA_TOKEN (or ATLASSIAN_API_TOKEN) not set: ${envHint()}.`);
  return config;
}

/** Confluence is optional: probe skips it, the wiki commands require it. */
export function loadConfluenceConfig(): ServiceConfig | undefined {
  return loadService('Confluence', 'CONFLUENCE');
}

/** Login / SSO page instead of the resource (path or query, e.g. ADFS /adfs/ls/?SAMLRequest=…). */
function isLoginRedirect(url: URL): boolean {
  return /(^|\.)id\.atlassian\.com$/.test(url.hostname)
    || /login|signin|sso|saml|oauth|authenticate|adfs/i.test(url.pathname)
    || /SAMLRequest|os_destination|RelayState/i.test(url.search);
}

/** URL without the query: signed links carry tokens there, so it never goes to the output. */
function withoutQuery(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function authorization(config: ServiceConfig): string {
  return config.auth === 'basic'
    ? `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`
    : `Bearer ${config.token}`;
}

export class RestClient {
  private readonly config: ServiceConfig;
  constructor(config: ServiceConfig) {
    this.config = config;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get cloud(): boolean {
    return this.config.cloud;
  }

  /** For probe output: auth mode without secrets */
  get authLabel(): string {
    return this.config.auth === 'basic' ? `basic (${this.config.email} + API token)` : 'bearer (PAT)';
  }

  /** Absolute URL; relative paths (incl. Confluence _links.download) are resolved against baseUrl. */
  url(path: string): string {
    return path.startsWith('http') ? path : `${this.config.baseUrl}${path}`;
  }

  async raw(path: string, init: { accept?: string; method?: 'GET' | 'POST'; json?: unknown } = {}): Promise<Response> {
    const { label } = this.config;
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: init.method ?? 'GET',
        headers: {
          Authorization: authorization(this.config),
          Accept: init.accept ?? 'application/json',
          ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        redirect: 'manual',
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new HttpError(0, path, `${label}: network error: ${cause?.code ?? ''} ${cause?.message ?? (e as Error).message}`);
    }
    const loginReason = res.headers.get('x-seraph-loginreason');
    if (loginReason?.includes('AUTHENTICATION_DENIED')) {
      throw new HttpError(res.status, path, `${label} requires CAPTCHA — log in via the browser, then retry.`);
    }
    if (res.status === 401) {
      const hint = this.config.auth === 'basic'
        ? 'Check the email and API token (id.atlassian.com → Security → API tokens) and whether it has expired.'
        : 'Check the PAT and whether it has expired. Atlassian Cloud needs basic auth: set ATLASSIAN_EMAIL.';
      throw new HttpError(401, path, `${label}: token rejected (401). ${hint}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      const target = location ? new URL(location, this.url(path)) : undefined;
      // A redirect to an SSO/login page instead of JSON — the token did not work or the URL is wrong.
      // For API (JSON) requests any redirect is an error; it may be followed only when downloading a file.
      const isFileDownload = (init.accept ?? 'application/json') !== 'application/json';
      if (!target || !isFileDownload || isLoginRedirect(target)) {
        throw new HttpError(res.status, path, `${label}: redirect to ${target ? withoutQuery(target) : '?'} — looks like SSO/login, not REST.`);
      }
      // Otherwise it is a file (e.g. a Cloud attachment → signed media-store link): GET without our Authorization —
      // the link is already signed, and credentials are never sent to another host.
      try {
        return await fetch(target, { headers: { Accept: init.accept ?? '*/*' }, redirect: 'follow' });
      } catch (e) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        throw new HttpError(0, path, `${label}: network error (${withoutQuery(target)}): ${cause?.code ?? ''} ${cause?.message ?? (e as Error).message}`);
      }
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    return this.json<T>(path, await this.raw(path));
  }

  /** POST only for read requests that Cloud exposes only as POST (e.g. approximate-count). */
  async postRead<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, await this.raw(path, { method: 'POST', json: body }));
  }

  private async json<T>(path: string, res: Response): Promise<T> {
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { errorMessages?: string[]; message?: string };
        detail = body.errorMessages?.join('; ') || body.message || '';
      } catch {
        // body is not JSON — keep only the status
      }
      throw new HttpError(res.status, path, `${this.config.label}: HTTP ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as T;
  }
}

/**
 * JQL search on both platforms. Server/DC: GET /rest/api/2/search (has total). Cloud: the old /search is gone —
 * GET /rest/api/3/search/jql (no total; the fields read here are the same as in v2).
 */
export async function searchIssues(jira: RestClient, jql: string, fields: string, maxResults: number): Promise<{ issues: any[]; total?: number }> {
  const q = `jql=${encodeURIComponent(jira.cloud ? boundedJql(jql) : jql)}&fields=${encodeURIComponent(fields)}&maxResults=${maxResults}`;
  if (!jira.cloud) {
    const r = await jira.get<{ issues: any[]; total: number }>(`/rest/api/2/search?${q}`);
    return { issues: r.issues, total: r.total };
  }
  const r = await jira.get<{ issues?: any[] }>(`/rest/api/3/search/jql?${q}`);
  return { issues: r.issues ?? [] };
}

/** Issue count for a JQL. Cloud: POST /rest/api/3/search/approximate-count (read-only, approximate). */
export async function countIssues(jira: RestClient, jql: string): Promise<number> {
  if (!jira.cloud) return (await searchIssues(jira, jql, 'id', 0)).total ?? 0;
  // approximate-count does not accept ORDER BY
  const bare = boundedJql(jql).replace(/\s*order\s+by\s+.*$/i, '');
  return (await jira.postRead<{ count: number }>('/rest/api/3/search/approximate-count', { jql: bare })).count;
}

/**
 * Cloud search rejects JQL without any condition ("Unbounded JQL queries are not allowed"), e.g. `order by updated DESC`.
 * Such a query gets a catch-all condition: created within the last 100 years.
 */
function boundedJql(jql: string): string {
  const condition = jql.replace(/\s*order\s+by\s+.*$/i, '').trim();
  return condition ? jql : `created >= -36500d ${jql}`.trim();
}

/** User id: name/username (Server/DC) or accountId (Cloud, GDPR). */
export function userId(u: any): string | undefined {
  return u?.name ?? u?.username ?? u?.accountId;
}

/** 401 / CAPTCHA / login redirect / network — retrying is pointless (and risky with CAPTCHA). */
export function isFatal(e: unknown): boolean {
  return (
    e instanceof HttpError &&
    (e.status === 0 || e.status === 401 || (e.status >= 300 && e.status < 400) || e.message.includes('CAPTCHA'))
  );
}
