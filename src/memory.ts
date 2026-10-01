// SPDX-License-Identifier: Apache-2.0
//
// Memory guard: MIMIC's equivalent of Redis' `maxmemory` with the
// `noeviction` policy.
//
// Everything MIMIC stores lives on the V8 heap, which has a hard ceiling
// (the old-space limit, set by --max-old-space-size and often well below the
// machine's RAM). Running into it aborts the process and the whole cache is
// lost. So once the heap passes a share of that ceiling, commands that can
// grow memory (Redis' "denyoom" commands: SET, LPUSH, HSET, ...) are refused
// with Redis' own -OOM error, while reads, deletes and expiry keep working.

import v8 from 'node:v8';
import vm from 'node:vm';

export const OOM_MESSAGE = "command not allowed when used memory > 'maxmemory'.";

const MiB = 1024 * 1024;
/**
 * While over the limit, force a full GC at most every GC_INTERVAL_MS, and
 * never more than 1/GC_COST_RATIO of the time (a full GC of a 4 GB heap can
 * take seconds, and it blocks the event loop).
 */
const GC_INTERVAL_MS = 1000;
const GC_COST_RATIO = 20;
const RECHECK_CALLS = 256; // re-measure after this many guarded commands...
const RECHECK_BYTES = 256 * 1024; // ...or this many argument bytes, whichever comes first
/**
 * V8 aborts before the old space is completely full: a scavenge must be able
 * to promote a whole semi-space (16 MB on 64-bit) into it. Keep this much free
 * whatever the percentage says, so small heaps (--max-old-space-size=64) are
 * protected too.
 */
const V8_HEADROOM = 32 * MiB;
/** heap_size_limit = old space + 3 semi-spaces of 16 MB (64-bit Node 18-22, default flags). */
const YOUNG_GENERATION = 48 * MiB;

/**
 * Committed size of the old generation (everything but the young-generation
 * spaces). That's what V8 compares with its limit - not the live bytes: with
 * values of tens of KB, page fragmentation alone can add 25%.
 */
export function oldGenerationSize(): number {
  let size = 0;
  for (const space of v8.getHeapSpaceStatistics()) if (!space.space_name.startsWith('new_')) size += space.space_size;
  return size;
}

export interface MemoryGuardSource {
  /** Bytes counted against the limit (default: oldGenerationSize). */
  measure?: () => number;
  /** V8's heap_size_limit (default: from v8.getHeapStatistics). */
  heapSizeLimit?: number;
  /** --max-old-space-size in MB, null = not set (default: read from the command line and NODE_OPTIONS). */
  oldSpaceFlagMb?: number | null;
}

let forceGc: (() => void) | null | undefined;

/**
 * A full garbage collection, if we can get one. After FLUSHALL or many DELs
 * the freed space only shows up after V8's next major GC, which may not come
 * soon while writes are being refused; without it the guard could stay
 * closed. Exposed at runtime (the well-known `--expose-gc` + vm trick), only
 * when actually needed.
 */
function collect(): boolean {
  if (forceGc === undefined) {
    try {
      v8.setFlagsFromString('--expose-gc');
      forceGc = vm.runInNewContext('gc') as () => void;
    } catch {
      forceGc = null;
    }
  }
  if (!forceGc) return false;
  forceGc();
  return true;
}

/** --max-old-space-size in MB from the command line or NODE_OPTIONS, if set. */
function oldSpaceFlagMb(): number | undefined {
  // NODE_OPTIONS is applied first, so the command line overrides it.
  const args = [...(process.env['NODE_OPTIONS'] ?? '').split(/\s+/), ...process.execArgv];
  let found: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const m = /^--max[-_]old[-_]space[-_]size(?:=(\d+))?$/.exec(args[i]!);
    if (!m) continue;
    const v = Number(m[1] ?? args[i + 1]);
    if (Number.isFinite(v) && v > 0) found = v; // the last one wins, as in V8
  }
  return found;
}

/** The V8 old-space ceiling in bytes: the flag if given, else heap_size_limit minus the young generation. */
export function oldSpaceLimit(heapSizeLimit: number, flagMb: number | null | undefined = oldSpaceFlagMb()): number {
  if (typeof flagMb === 'number') return Math.min(flagMb * MiB, heapSizeLimit);
  return heapSizeLimit > 2 * YOUNG_GENERATION ? heapSizeLimit - YOUNG_GENERATION : Math.floor(heapSizeLimit / 2);
}

export class MemoryGuard {
  /** Memory use above which growing writes are refused (0 = disabled). */
  readonly limitBytes: number;
  /** V8's old-space ceiling, the point where the process would abort. */
  readonly heapLimitBytes: number;
  #over = false;
  #calls = 0;
  #bytes = 0;
  #lastGc = 0;
  #lastGcMs = 0;
  #gcDue = true; // the first time over the limit, check it isn't just garbage
  readonly #measure: () => number;

  /**
   * `percent` of the V8 old-space limit (always keeping V8_HEADROOM free);
   * 0 disables the guard.
   */
  constructor(percent: number, source: MemoryGuardSource = {}) {
    this.#measure = source.measure ?? oldGenerationSize;
    this.heapLimitBytes = oldSpaceLimit(source.heapSizeLimit ?? v8.getHeapStatistics().heap_size_limit, source.oldSpaceFlagMb);
    if (percent <= 0) {
      this.limitBytes = 0;
    } else {
      const share = Math.floor((this.heapLimitBytes * Math.min(percent, 100)) / 100);
      // Never closer to the ceiling than V8_HEADROOM (but on tiny heaps, at least half of it is usable).
      this.limitBytes = Math.min(share, Math.max(Math.floor(this.heapLimitBytes / 2), this.heapLimitBytes - V8_HEADROOM));
    }
  }

  /** Current old-generation size, as compared with limitBytes. */
  get usedBytes(): number {
    return this.#measure();
  }

  get enabled(): boolean {
    return this.limitBytes > 0;
  }

  /** Re-measure the heap (called from the store's timer, and as writes come in). */
  refresh(): void {
    if (!this.enabled) return;
    this.#calls = 0;
    this.#bytes = 0;
    // Only the V8 heap counts: that's the limit that aborts the process.
    // (Off-heap Buffers, e.g. large APPEND values, don't count against it.)
    let used = this.#measure();
    if (used > this.limitBytes) {
      // The heap may be mostly garbage (V8 collects lazily, and with writes
      // refused, nothing allocates enough to trigger a collection), so make sure.
      const now = Date.now();
      if (this.#gcDue || now - this.#lastGc >= Math.max(GC_INTERVAL_MS, this.#lastGcMs * GC_COST_RATIO)) {
        this.#gcDue = false;
        if (collect()) {
          this.#lastGc = Date.now();
          this.#lastGcMs = this.#lastGc - now;
          used = this.#measure();
        }
      }
    } else {
      this.#gcDue = true;
    }
    this.#over = used > this.limitBytes;
  }

  /** Memory was just released in bulk (FLUSHDB/FLUSHALL): re-check now, collecting if needed. */
  freed(): void {
    if (!this.#over) return;
    this.#gcDue = true;
    this.refresh();
  }

  /**
   * True while commands that grow memory must be refused. Cheap to call;
   * `bytes` (the command's argument size) makes big writes re-measure sooner,
   * so a burst of large SETs can't overshoot the limit between checks.
   */
  overLimit(bytes = 0): boolean {
    if (!this.enabled) return false;
    this.#bytes += bytes;
    if (++this.#calls >= RECHECK_CALLS || this.#bytes >= RECHECK_BYTES) this.refresh();
    return this.#over;
  }
}
