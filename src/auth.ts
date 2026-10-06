// SPDX-License-Identifier: Apache-2.0
//
// Authentication helpers shared by the RESP and HTTP servers:
//
//   * PasswordCheck - holds only a SHA-256 hash of the password and compares
//     candidates in constant time. The password can be given as plain text or,
//     so that config files need not contain it, as "sha256:<64 hex digits>".
//   * AuthGuard - counts failed attempts per client IP and blocks an address
//     for a while after too many, so the password can't be guessed at network
//     speed. Loopback addresses are never blocked (a misconfigured local app
//     must not lock out every other local client), only logged.
//   * isLoopback - used by protected mode and the guard.

import { createHash, timingSafeEqual } from 'node:crypto';

const HASHED = /^sha256:([0-9a-f]{64})$/i;

/** "sha256:<hex>" for a password, as accepted by --password / --password-file. */
export function hashPassword(password: string): string {
  return `sha256:${createHash('sha256').update(password, 'utf8').digest('hex')}`;
}

export class PasswordCheck {
  readonly #hash: Buffer;
  /** True when the configuration held only a hash (never the plain password). */
  readonly hashed: boolean;

  /** `configured`: the plain password (text), or "sha256:<hex>". */
  constructor(configured: string) {
    const m = HASHED.exec(configured);
    this.hashed = m !== null;
    this.#hash = m ? Buffer.from(m[1]!, 'hex') : createHash('sha256').update(configured, 'utf8').digest();
  }

  /** `given` is a binary string (one char per byte), as AUTH arguments and HTTP headers are. */
  matches(given: string): boolean {
    return timingSafeEqual(createHash('sha256').update(given, 'latin1').digest(), this.#hash);
  }
}

/** 127.0.0.0/8 and ::1, including IPv4-mapped IPv6 (::ffff:127.0.0.1). */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export interface AuthGuardOptions {
  /** Failed attempts from one address within `windowMs` before it is blocked; 0 = never block. */
  maxFailures: number;
  windowMs?: number;
  /** How long a blocked address stays blocked. */
  blockMs?: number;
  /** Warnings about failures and blocks. */
  warn?: (msg: string) => void;
}

interface AttemptRecord {
  failures: number;
  windowStart: number;
  blockedUntil: number;
  logged: boolean;
}

const MAX_TRACKED = 10_000; // bound the table itself

/** The same client over IPv4 and IPv4-mapped IPv6 ("::ffff:10.0.0.1") counts as one address. */
const keyOf = (address: string | undefined): string | undefined =>
  address?.startsWith('::ffff:') ? address.slice(7) : address;

export class AuthGuard {
  readonly #records = new Map<string, AttemptRecord>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #blockMs: number;
  readonly #warn: (msg: string) => void;

  constructor(opts: AuthGuardOptions) {
    this.#max = opts.maxFailures;
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#blockMs = opts.blockMs ?? 60_000;
    this.#warn = opts.warn ?? (() => {});
  }

  /** Whether connections / requests from this address are currently refused. */
  isBlocked(address: string | undefined): boolean {
    const key = keyOf(address);
    if (!key) return false;
    const r = this.#records.get(key);
    return r !== undefined && r.blockedUntil > Date.now();
  }

  /** Seconds until the block on `address` ends (for Retry-After). */
  retryAfterSec(address: string | undefined): number {
    const key = keyOf(address);
    const r = key ? this.#records.get(key) : undefined;
    return r ? Math.max(1, Math.ceil((r.blockedUntil - Date.now()) / 1000)) : 1;
  }

  /** Record a failed attempt. Returns true if the address is now blocked. */
  recordFailure(address: string | undefined, via: string): boolean {
    const ip = keyOf(address) ?? 'unknown';
    const now = Date.now();
    let r = this.#records.get(ip);
    if (!r || now - r.windowStart > this.#windowMs) {
      if (!r && this.#records.size >= MAX_TRACKED) this.#evict(now);
      r = { failures: 0, windowStart: now, blockedUntil: r?.blockedUntil ?? 0, logged: false };
      this.#records.set(ip, r);
    }
    r.failures++;
    // One warning per address per window, so a guessing attack can't flood the log.
    if (!r.logged) {
      r.logged = true;
      this.#warn(`[auth] failed authentication from ${ip} (${via})`);
    }
    if (this.#max > 0 && r.failures >= this.#max && r.blockedUntil <= now && !isLoopback(address)) {
      r.blockedUntil = now + this.#blockMs;
      this.#warn(
        `[auth] ${ip} blocked for ${Math.round(this.#blockMs / 1000)} s after ${r.failures} failed authentication attempts in ${Math.round(this.#windowMs / 1000)} s`,
      );
      return true;
    }
    return this.isBlocked(address);
  }

  #evict(now: number): void {
    for (const [ip, r] of this.#records) {
      if (r.blockedUntil <= now && now - r.windowStart > this.#windowMs) this.#records.delete(ip);
    }
    // Still nearly full (an attack from very many addresses): drop the oldest
    // tenth in one go, so this scan doesn't run again for the next thousand
    // new addresses. This is a hard cap: an attacker who controls thousands of
    // addresses could lift the oldest blocks, but each of those addresses
    // still only gets a few guesses a minute.
    for (const ip of this.#records.keys()) {
      if (this.#records.size < MAX_TRACKED * 0.9) break;
      this.#records.delete(ip);
    }
  }
}
