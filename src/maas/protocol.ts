/**
 * TraceForge MaaS — MCP / JSON-RPC protocol primitives.
 *
 * 100% independent of Health eRecords: zero imports from outside this
 * repository, zero external credentials, zero network calls. Pure types,
 * constants, correlation IDs, and a zero-dependency JSON-schema validator.
 */

/** MCP Streamable-HTTP protocol version pinned for TraceForge MaaS. */
export const MCP_PROTOCOL_VERSION = '2025-06-18' as const;
/** JSON-RPC wire version used on every `/api/mcp` + `/mcp` envelope. */
export const JSON_RPC_VERSION = '2.0' as const;

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope (exactly one of `result` / `error`). */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Standard JSON-RPC error codes used by the MaaS middleware. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/** Every structured error code the MaaS layer can emit. */
export type MaasErrorCode =
  | 'MAAS_INVALID_REQUEST'
  | 'MAAS_SCHEMA_VALIDATION_FAILED'
  | 'MAAS_CAPABILITY_NOT_FOUND'
  | 'MAAS_AUTHENTICATION_REQUIRED'
  | 'MAAS_CREDENTIALS_REVOKED'
  | 'MAAS_AUTHORIZATION_DENIED'
  | 'MAAS_CROSS_TENANT_ACCESS_DENIED'
  | 'MAAS_RATE_LIMIT_EXCEEDED'
  | 'MAAS_KILL_SWITCH_ACTIVE'
  | 'MAAS_BUDGET_THRESHOLD_EXCEEDED'
  | 'MAAS_PROBE_BUDGET_EXHAUSTED'
  | 'MAAS_SESSION_ALREADY_EVALUATED'
  | 'MAAS_INVESTIGATION_INCOMPLETE'
  | 'MAAS_RESOURCE_NOT_FOUND'
  | 'MAAS_UPSTREAM_UNAVAILABLE'
  | 'MAAS_EXECUTION_FAILED'
  | 'MAAS_POSTCONDITION_VERIFICATION_FAILED';

/** Structured error payload returned inside tool results and audit events. */
export interface MaasStructuredError {
  code: MaasErrorCode;
  message: string;
  correlationId: string;
  capability?: string;
  details?: Record<string, unknown>;
}

/** Minimal JSON-schema subset used for MaaS tool input schemas. */
export interface MaasJsonSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  properties?: Record<string, MaasJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: MaasJsonSchema;
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

/** MCP-style tool annotations (hints for remote MCP clients). */
export interface MaasToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** One registered MaaS capability descriptor. */
export interface MaasCapabilityDescriptor {
  name: string;
  description: string;
  inputSchema: MaasJsonSchema;
  requiredScope: string | null;
  annotations: MaasToolAnnotations;
}

let correlationSeq = 0;

/**
 * Create a unique correlation id for one MaaS call / receipt chain link.
 * Format: `<prefix>_<base36-timestamp>-<seq>-<base36-random>`.
 */
export function createMaasCorrelationId(prefix = 'tf_corr'): string {
  correlationSeq += 1;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, '0');
  return `${prefix}_${time}-${correlationSeq.toString(36)}-${rand}`;
}

/** Normalize a tool name so `tools/call` accepts dotted and underscored forms. */
export function normalizeToolName(name: string): string {
  return name.split('.').flatMap((segment) => segment.split('_')).join('.');
}

export interface MaasSchemaValidation {
  valid: boolean;
  errors: string[];
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkType(value: unknown, expected: MaasJsonSchema['type']): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Zero-dependency validator for the `MaasJsonSchema` subset. Checks required
 * fields, `additionalProperties: false`, primitive types, `enum`,
 * `minLength` / `maxLength` (strings), and `minimum` / `maximum` (numbers).
 * Object properties and array items are validated recursively.
 */
export function validateAgainstMaasSchema(
  payload: unknown,
  schema: MaasJsonSchema,
  path = '$',
): MaasSchemaValidation {
  const errors: string[] = [];
  if (!checkType(payload, schema.type)) {
    return { valid: false, errors: [`${path}: expected ${schema.type}, got ${typeOfValue(payload)}`] };
  }
  if (schema.enum !== undefined && !schema.enum.includes(payload as string | number | boolean)) {
    errors.push(`${path}: value not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(', ')}]`);
  }
  if (schema.type === 'string' && typeof payload === 'string') {
    if (schema.minLength !== undefined && payload.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && payload.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
  }
  if ((schema.type === 'number' || schema.type === 'integer') && typeof payload === 'number') {
    if (schema.minimum !== undefined && payload < schema.minimum) {
      errors.push(`${path}: ${payload} below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && payload > schema.maximum) {
      errors.push(`${path}: ${payload} above maximum ${schema.maximum}`);
    }
  }
  if (schema.type === 'object' && payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) {
        errors.push(`${path}: missing required field '${key}'`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: unknown property '${key}' (additionalProperties is false)`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in record && record[key] !== undefined) {
          const subResult = validateAgainstMaasSchema(record[key], sub, `${path}.${key}`);
          errors.push(...subResult.errors);
        }
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(payload) && schema.items) {
    payload.forEach((item, index) => {
      const subResult = validateAgainstMaasSchema(item, schema.items as MaasJsonSchema, `${path}[${index}]`);
      errors.push(...subResult.errors);
    });
  }
  return { valid: errors.length === 0, errors };
}

/** Build a `MaasStructuredError` payload for one failed call. */
export function maasError(
  code: MaasErrorCode,
  message: string,
  correlationId: string,
  capability?: string,
  details?: Record<string, unknown>,
): MaasStructuredError {
  return { code, message, correlationId, ...(capability ? { capability } : {}), ...(details ? { details } : {}) };
}
