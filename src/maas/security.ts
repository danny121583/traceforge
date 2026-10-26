/**
 * TraceForge MaaS — independent security layer.
 *
 * Authentication (built-in local bearer tokens), role/scope authorization,
 * sliding-window rate limiting, hierarchical kill switch, and sanitized audit
 * logging. 100% independent of Health eRecords: local token registry only,
 * no external identity provider, no external credentials.
 */

import type { MaasErrorCode } from './protocol';

/* ---------------------------------------------------------------------------
 * Token registry (independent local trust root)
 * ------------------------------------------------------------------------- */

export type MaasRole = 'readonly' | 'agent' | 'owner';

export interface MaasTokenRecord {
  token: string;
  actorId: string;
  role: MaasRole;
  scopes: string[];
}

/** Built-in independent local tokens — the only credentials this layer knows. */
export const MAAS_LOCAL_TOKENS: MaasTokenRecord[] = [
  {
    token: 'tf_readonly_local_token',
    actorId: 'actor_readonly',
    role: 'readonly',
    scopes: ['traceforge:discovery:read', 'traceforge:circuits:read', 'traceforge:scenarios:read'],
  },
  {
    token: 'tf_agent_local_token',
    actorId: 'actor_chatgpt_agent',
    role: 'agent',
    scopes: [
      'traceforge:discovery:read',
      'traceforge:circuits:read',
      'traceforge:scenarios:read',
      'traceforge:scenarios:write',
      'traceforge:measurements:read',
      'traceforge:measurements:execute',
      'traceforge:investigations:read',
      'traceforge:investigations:execute',
      'traceforge:evaluation:score',
    ],
  },
  {
    token: 'tf_agent_secondary_token',
    actorId: 'actor_secondary_agent',
    role: 'agent',
    scopes: [
      'traceforge:discovery:read',
      'traceforge:circuits:read',
      'traceforge:scenarios:read',
      'traceforge:scenarios:write',
      'traceforge:measurements:read',
      'traceforge:measurements:execute',
      'traceforge:investigations:read',
      'traceforge:investigations:execute',
      'traceforge:evaluation:score',
    ],
  },
  {
    token: 'tf_operator_live_token',
    actorId: 'actor_operator_owner',
    role: 'owner',
    scopes: [
      'traceforge:discovery:read',
      'traceforge:circuits:read',
      'traceforge:scenarios:read',
      'traceforge:scenarios:write',
      'traceforge:measurements:read',
      'traceforge:measurements:execute',
      'traceforge:investigations:read',
      'traceforge:investigations:execute',
      'traceforge:evaluation:score',
      'traceforge:live_inference:execute',
      'traceforge:audit:read',
    ],
  },
];

/** Authenticated caller context attached to one authorized call. */
export interface MaasAuthContext {
  actorId: string;
  role: MaasRole;
  scopes: string[];
  /** Present only for token-authenticated callers (absent for anonymous). */
  tokenLabel?: string;
  anonymous: boolean;
}

/** Security failure carrying a structured MaaS error code. */
export class MaasSecurityError extends Error {
  readonly code: MaasErrorCode;
  constructor(code: MaasErrorCode, message: string) {
    super(message);
    this.name = 'MaasSecurityError';
    this.code = code;
  }
}

/** Extract a bearer token from request headers (case-insensitive scheme). */
export function extractBearerToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers['authorization'] ?? headers['Authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

/* ---------------------------------------------------------------------------
 * Kill switch (hierarchical: global > write-freeze > per-tool > per-token)
 * ------------------------------------------------------------------------- */

export class MaasKillSwitch {
  private globalKill = false;
  private globalReason: string | undefined;
  private writeFreeze = false;
  private readonly disabledTools = new Set<string>();
  private readonly revokedTokens = new Set<string>();

  setGlobalKillSwitch(active: boolean, reason?: string): void {
    this.globalKill = active;
    this.globalReason = active ? (reason ?? 'operator global kill switch') : undefined;
  }

  isGlobalKillActive(): boolean {
    return this.globalKill;
  }

  getGlobalKillReason(): string | undefined {
    return this.globalReason;
  }

  setWriteFreeze(active: boolean): void {
    this.writeFreeze = active;
  }

  isWriteFreezeActive(): boolean {
    return this.writeFreeze;
  }

  disableTool(name: string): void {
    this.disabledTools.add(name);
  }

  enableTool(name: string): void {
    this.disabledTools.delete(name);
  }

  isToolDisabled(name: string): boolean {
    return this.disabledTools.has(name);
  }

  revokeToken(token: string): void {
    this.revokedTokens.add(token);
  }

  restoreToken(token: string): void {
    this.revokedTokens.delete(token);
  }

  isTokenRevoked(token: string): boolean {
    return this.revokedTokens.has(token);
  }

  snapshot(): { globalKill: boolean; reason?: string; writeFreeze: boolean; disabledTools: string[]; revokedTokenCount: number } {
    return {
      globalKill: this.globalKill,
      ...(this.globalReason ? { reason: this.globalReason } : {}),
      writeFreeze: this.writeFreeze,
      disabledTools: [...this.disabledTools],
      revokedTokenCount: this.revokedTokens.size,
    };
  }
}

/* ---------------------------------------------------------------------------
 * Sliding-window rate limiter (per actor/key)
 * ------------------------------------------------------------------------- */

export class MaasRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxRequestsPerWindow: number = 120,
    private readonly windowMs: number = 60_000,
  ) {}

  getMaxRequestsPerWindow(): number {
    return this.maxRequestsPerWindow;
  }

  getWindowMs(): number {
    return this.windowMs;
  }

  /** Record one call for `key`; throws `MAAS_RATE_LIMIT_EXCEEDED` when over budget. */
  check(key: string, nowMs: number = Date.now()): void {
    const cutoff = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxRequestsPerWindow) {
      this.hits.set(key, recent);
      throw new MaasSecurityError(
        'MAAS_RATE_LIMIT_EXCEEDED',
        `Rate limit exceeded for '${key}': more than ${this.maxRequestsPerWindow} requests per ${this.windowMs} ms.`,
      );
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}

/* ---------------------------------------------------------------------------
 * Authenticator: bearer tokens -> auth contexts, scope enforcement
 * ------------------------------------------------------------------------- */

export class MaasAuthenticator {
  private readonly tokens = new Map<string, MaasTokenRecord>();

  constructor(private readonly killSwitch: MaasKillSwitch, extraTokens: MaasTokenRecord[] = []) {
    for (const record of [...MAAS_LOCAL_TOKENS, ...extraTokens]) {
      this.tokens.set(record.token, record);
    }
  }

  /** Resolve headers to an auth context; throws when the token is revoked/unknown. */
  authenticate(headers: Record<string, string | string[] | undefined>): MaasAuthContext {
    const token = extractBearerToken(headers);
    if (!token) {
      return { actorId: 'anonymous', role: 'readonly', scopes: [], anonymous: true };
    }
    if (this.killSwitch.isTokenRevoked(token)) {
      throw new MaasSecurityError('MAAS_CREDENTIALS_REVOKED', 'Bearer token has been revoked by the operator.');
    }
    const record = this.tokens.get(token);
    if (!record) {
      throw new MaasSecurityError('MAAS_AUTHENTICATION_REQUIRED', 'Invalid bearer token: authentication required.');
    }
    return { actorId: record.actorId, role: record.role, scopes: [...record.scopes], tokenLabel: 'Bearer [REDACTED]', anonymous: false };
  }

  /**
   * Enforce access for one capability: public capabilities allow anonymous
   * readers; every other capability needs a valid token plus `requiredScope`.
   */
  authorize(context: MaasAuthContext, capabilityName: string, requiredScope: string | null): void {
    if (requiredScope === null) return;
    if (context.anonymous) {
      throw new MaasSecurityError(
        'MAAS_AUTHENTICATION_REQUIRED',
        `Capability '${capabilityName}' requires a valid Bearer token.`,
      );
    }
    if (!context.scopes.includes(requiredScope)) {
      throw new MaasSecurityError(
        'MAAS_AUTHORIZATION_DENIED',
        `Actor '${context.actorId}' lacks required scope '${requiredScope}' for '${capabilityName}'.`,
      );
    }
  }
}

/* ---------------------------------------------------------------------------
 * Sanitized audit log
 * ------------------------------------------------------------------------- */

export interface MaasAuditEvent {
  correlationId: string;
  timestamp: string;
  actorId: string;
  capability: string;
  outcome: 'success' | 'error';
  errorCode?: MaasErrorCode;
  /** Scrubbed argument summary (never contains secrets or raw tokens). */
  argumentsSummary: string;
}

const AUDIT_SECRET_PATTERNS: RegExp[] = [
  /META_API_KEY/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/=]+/g,
];

/** Scrub secrets out of arbitrary text: API-key markers, bearer tokens, known token strings. */
export function sanitizeForAuditText(text: string, knownSecrets: string[] = []): string {
  let out = text;
  for (const pattern of AUDIT_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => (match.toLowerCase().startsWith('bearer') ? 'Bearer [REDACTED]' : '[REDACTED]'));
  }
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export class MaasAuditLog {
  private readonly events: MaasAuditEvent[] = [];
  private readonly knownSecrets: string[];

  constructor(knownSecrets: string[] = MAAS_LOCAL_TOKENS.map((t) => t.token)) {
    this.knownSecrets = knownSecrets;
  }

  record(event: Omit<MaasAuditEvent, 'timestamp' | 'argumentsSummary'> & { argumentsSummary: unknown }): void {
    let summary: string;
    try {
      summary = JSON.stringify(event.argumentsSummary ?? {}) ?? '{}';
    } catch {
      summary = '{}';
    }
    if (summary.length > 2000) summary = `${summary.slice(0, 2000)}…[truncated]`;
    this.events.push({
      correlationId: event.correlationId,
      timestamp: new Date().toISOString(),
      actorId: event.actorId,
      capability: event.capability,
      outcome: event.outcome,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      argumentsSummary: sanitizeForAuditText(summary, this.knownSecrets),
    });
  }

  getEvents(): MaasAuditEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  clear(): void {
    this.events.length = 0;
  }
}
