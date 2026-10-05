// SPDX-License-Identifier: Apache-2.0
//
// TLS settings for the RESP TLS port and HTTPS, read once at startup.
//
// Certificates come either as PEM files (--tls-cert-file + --tls-key-file),
// or as one PKCS#12 bundle (--tls-pfx-file), which is what IBM i's Digital
// Certificate Manager exports. With --tls-ca-cert-file, client certificates
// can be required (mutual TLS); that is in addition to the password.

import { readFileSync } from 'node:fs';
import type tls from 'node:tls';
import { ConfigError, type MimicConfig } from './config.js';

function read(file: string, what: string): Buffer {
  try {
    return readFileSync(file);
  } catch (err) {
    throw new ConfigError(`cannot read ${what} ${file}: ${(err as Error).message}`);
  }
}

/** Build Node TLS server options from the configuration (files are read here). */
export function loadTlsOptions(c: MimicConfig): tls.TlsOptions {
  const opts: tls.TlsOptions = {
    minVersion: 'TLSv1.2', // TLS 1.0 / 1.1 are broken; Node's default is the same, but be explicit
  };
  if (c.tlsKeyPassFile !== undefined) {
    // Only the line break an editor adds is removed; the passphrase is otherwise taken as is.
    opts.passphrase = read(c.tlsKeyPassFile, 'TLS passphrase file').toString('utf8').replace(/\r?\n$/, '');
  }
  if (c.tlsPfxFile !== undefined) {
    opts.pfx = read(c.tlsPfxFile, 'PKCS#12 file');
  } else {
    opts.cert = read(c.tlsCertFile!, 'TLS certificate file');
    opts.key = read(c.tlsKeyFile!, 'TLS key file');
  }
  if (c.tlsCaCertFile !== undefined) opts.ca = read(c.tlsCaCertFile, 'TLS CA certificate file');
  opts.requestCert = c.tlsAuthClients !== 'no';
  opts.rejectUnauthorized = c.tlsAuthClients === 'yes';
  return opts;
}
