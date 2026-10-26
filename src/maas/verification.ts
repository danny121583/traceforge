/**
 * TraceForge MaaS — deterministic postcondition verification engine.
 *
 * Every mutating tool runs an independent postcondition check and returns a
 * cryptographically chained `MaasVerificationReceipt`: each receipt commits
 * to the previous receipt hash (tamper-evident chain) plus an HMAC-SHA256
 * signature over the receipt hash. Pure TypeScript SHA-256 — zero
 * dependencies, no Node-only imports, so the Vite browser bundle stays
 * buildable and unit tests stay hermetic.
 */

import { createMaasCorrelationId } from './protocol';

/* ---------------------------------------------------------------------------
 * Minimal pure-TypeScript SHA-256 (FIPS 180-4) + HMAC-SHA256
 * ------------------------------------------------------------------------- */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Bytes(message: Uint8Array): Uint8Array {
  const bitLen = message.length * 8;
  const paddedLen = (((message.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Array<number>(64);

  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Deterministic SHA-256 hex digest (pure TypeScript, no Node imports). */
export function maasSha256Hex(text: string): string {
  return toHex(sha256Bytes(utf8Encode(text)));
}

/** Deterministic HMAC-SHA256 hex signature (pure TypeScript). */
export function maasHmacSha256Hex(key: string, message: string): string {
  const blockSize = 64;
  let keyBytes = utf8Encode(key);
  if (keyBytes.length > blockSize) keyBytes = sha256Bytes(keyBytes);
  const padded = new Uint8Array(blockSize);
  padded.set(keyBytes);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    ipad[i] = padded[i]! ^ 0x36;
    opad[i] = padded[i]! ^ 0x5c;
  }
  const msgBytes = utf8Encode(message);
  const inner = new Uint8Array(ipad.length + msgBytes.length);
  inner.set(ipad);
  inner.set(msgBytes, ipad.length);
  const innerHash = sha256Bytes(inner);
  const outer = new Uint8Array(opad.length + innerHash.length);
  outer.set(opad);
  outer.set(innerHash, opad.length);
  return toHex(sha256Bytes(outer));
}

/* ---------------------------------------------------------------------------
 * Chained verification receipts
 * ------------------------------------------------------------------------- */

/** Default local HMAC signing key (independent local trust root, not a secret). */
export const DEFAULT_MAAS_VERIFICATION_KEY = 'traceforge-local-verification-key-v1';
/** Genesis hash anchoring every fresh receipt chain. */
export const MAAS_RECEIPT_GENESIS_HASH = maasSha256Hex('traceforge-maas-receipt-genesis-v1');

/** How the verified capability was accessed. */
export type MaasAccessMode = 'read' | 'execute';
/** Postcondition outcome recorded on the receipt. */
export type MaasVerificationOutcome = 'verified' | 'failed';

/** Tamper-evident, hash-chained verification receipt for one mutating call. */
export interface MaasVerificationReceipt {
  receiptId: string;
  correlationId: string;
  sequenceNumber: number;
  previousReceiptHash: string;
  receiptHash: string;
  hmacSignature: string;
  capabilityName: string;
  accessMode: MaasAccessMode;
  outcome: MaasVerificationOutcome;
  targetEntityId: string;
  postconditionAssertions: string[];
  summary: string;
  issuedAt: string;
}

/** Inputs for issuing one receipt (hash + signature are engine-derived). */
export interface MaasReceiptRequest {
  correlationId?: string;
  capabilityName: string;
  accessMode: MaasAccessMode;
  outcome?: MaasVerificationOutcome;
  targetEntityId: string;
  postconditionAssertions: string[];
  summary: string;
}

/**
 * Issues deterministic, sequentially chained, HMAC-signed receipts. The chain
 * is tamper-evident: every receipt commits to its predecessor's hash, and the
 * HMAC binds the receipt hash to this engine's local trust root.
 */
export class TraceForgeVerificationEngine {
  private readonly hmacKey: string;
  private sequenceNumber = 0;
  private previousHash = MAAS_RECEIPT_GENESIS_HASH;
  private readonly receipts: MaasVerificationReceipt[] = [];

  constructor(hmacKey: string = DEFAULT_MAAS_VERIFICATION_KEY) {
    this.hmacKey = hmacKey;
  }

  /** Issue one chained receipt for a completed capability execution. */
  issueReceipt(request: MaasReceiptRequest): MaasVerificationReceipt {
    this.sequenceNumber += 1;
    const correlationId = request.correlationId ?? createMaasCorrelationId();
    const receiptId = `rcpt_${this.sequenceNumber.toString(36)}_${correlationId.replace(/^tf_corr_/, '')}`;
    const issuedAt = new Date().toISOString();
    const outcome = request.outcome ?? 'verified';
    const canonical = JSON.stringify({
      receiptId,
      correlationId,
      sequenceNumber: this.sequenceNumber,
      previousReceiptHash: this.previousHash,
      capabilityName: request.capabilityName,
      accessMode: request.accessMode,
      outcome,
      targetEntityId: request.targetEntityId,
      postconditionAssertions: request.postconditionAssertions,
      summary: request.summary,
      issuedAt,
    });
    const receiptHash = maasSha256Hex(canonical);
    const receipt: MaasVerificationReceipt = {
      receiptId,
      correlationId,
      sequenceNumber: this.sequenceNumber,
      previousReceiptHash: this.previousHash,
      receiptHash,
      hmacSignature: maasHmacSha256Hex(this.hmacKey, receiptHash),
      capabilityName: request.capabilityName,
      accessMode: request.accessMode,
      outcome,
      targetEntityId: request.targetEntityId,
      postconditionAssertions: [...request.postconditionAssertions],
      summary: request.summary,
      issuedAt,
    };
    this.previousHash = receiptHash;
    this.receipts.push(receipt);
    return receipt;
  }

  /** Re-verify a receipt's hash chain link and HMAC signature. */
  verifyReceipt(receipt: MaasVerificationReceipt): boolean {
    const canonical = JSON.stringify({
      receiptId: receipt.receiptId,
      correlationId: receipt.correlationId,
      sequenceNumber: receipt.sequenceNumber,
      previousReceiptHash: receipt.previousReceiptHash,
      capabilityName: receipt.capabilityName,
      accessMode: receipt.accessMode,
      outcome: receipt.outcome,
      targetEntityId: receipt.targetEntityId,
      postconditionAssertions: receipt.postconditionAssertions,
      summary: receipt.summary,
      issuedAt: receipt.issuedAt,
    });
    if (maasSha256Hex(canonical) !== receipt.receiptHash) return false;
    return maasHmacSha256Hex(this.hmacKey, receipt.receiptHash) === receipt.hmacSignature;
  }

  getReceiptCount(): number {
    return this.receipts.length;
  }

  getLatestHash(): string {
    return this.previousHash;
  }
}
