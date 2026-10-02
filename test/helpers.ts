import net from 'node:net';
import { loadConfig, type MimicConfig } from '../src/config.js';
import { startDaemon, type Daemon } from '../src/daemon.js';
import type { Logger } from '../src/resp/server.js';

/** Start a daemon on random ports. */
export async function startTestDaemon(overrides: Partial<MimicConfig> = {}, logger?: Logger): Promise<Daemon> {
  const { config } = loadConfig([], {});
  return startDaemon({ ...config, port: 0, httpPort: 0, cleanupIntervalMs: 20, ...overrides }, logger);
}

/** Minimal raw RESP client: send bytes, collect the reply bytes until `until` matches or the socket closes. */
export function rawExchange(port: number, payload: string | Buffer, until?: (s: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const done = (): void => {
      socket.destroy();
      resolve(data);
    };
    socket.on('data', (c) => {
      data += c.toString('latin1');
      if (until?.(data)) done();
    });
    socket.on('end', done);
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(payload));
  });
}

/** Encode a command the way client libraries do. */
export function cmd(...args: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
