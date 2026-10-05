# Security policy

MIMIC is a personal open-source project, maintained in spare time. Security reports are welcome and taken seriously; please read this page before sending one.

## Supported versions

MIMIC is pre-1.0. Only the latest release gets security fixes.

| Version | Supported |
|---|---|
| Latest 0.x release | Yes |
| Older releases | No; please upgrade |

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately instead:

- **GitHub:** use [Report a vulnerability](../../security/advisories/new) on this repository's Security tab.

Please include:

- the MIMIC version (`mimic --version`), Node.js version, and platform (IBM i release, or OS);
- how MIMIC was configured (flags or `MIMIC_*` variables; **leave out real passwords**);
- the steps or commands that reproduce the problem, ideally as a short script;
- what you expected and what happened (a crash, data exposed, a check bypassed…).

## What to expect

- **Acknowledgement** within 7 days.
- **First assessment** (whether it's a vulnerability, and how serious) within 14 days.
- **A fix or a mitigation** as soon as practical, depending on severity and complexity. You'll be kept informed along the way.
- **Disclosure:** once a fix is released, the issue is described in the CHANGELOG and, where useful, a GitHub security advisory. Reporters are credited unless they prefer not to be. Please give the project up to 90 days before disclosing publicly; that can be shortened by agreement once a fix is out.

As this is a spare-time project, there is no bug bounty.

## Scope

**In scope**, for example:

- crashing or hanging the server from a client **without** the password;
- getting around authentication, protected mode, the failed-login blocking, the login timeout, TLS client-certificate checks, `--disable-commands`, the pre-AUTH limits, or the HTTP API's browser protections (Origin, `Sec-Fetch-Site`, Host checks, Content-Type);
- reading or changing data without the password;
- running code on the server, reading or writing files, or reaching anything outside MIMIC's own data;
- secrets leaking into logs or error messages (other than with `--log-level debug`, which logs values by design);
- a client using far more memory or CPU than its limits should allow, in a way that hurts other clients.

**Out of scope**, because they are documented behaviour (see [Security model](#security-model)):

- anything someone can do **with** the password, including `FLUSHALL` and reading every database;
- reading traffic on the network when TLS isn't used;
- problems when MIMIC is exposed to a network without a password and with protected mode turned off;
- an authenticated client slowing the server down with expensive commands such as `KEYS *`, as Redis can be;
- data being lost on restart: MIMIC is an in-memory cache;
- vulnerabilities in Node.js itself (please report those to the Node.js project), unless MIMIC uses Node in an unsafe way.

If you're not sure, report it anyway.

## Security model

MIMIC is built to run **next to its clients**, by default on `127.0.0.1`, and to be used by trusted applications. The model is the same as Redis without ACLs:

- **One password, full access.** Whoever has the password can run every command in every database. Databases (`SELECT`, `?db=N`) separate applications' keys; they are **not** a security boundary. If two applications must not see each other's data, run two MIMIC instances on different ports with different passwords.
- **No password means anyone who can connect has full access.** That is safe on `127.0.0.1` only if you trust every program and user on the machine.
- **Commands that are dangerous in Redis don't exist in MIMIC.** There is no `CONFIG SET`, `SAVE`/`BGSAVE`, `MODULE`, `REPLICAOF`, `DEBUG` or Lua scripting. These are the usual ways from Redis access to running code or writing files on the server.
- **Zero runtime dependencies.** Only Node.js itself runs in production; the dev dependencies are for building and testing.

What MIMIC protects against:

- **Clients on other machines when there is no password:** protected mode (on by default) accepts only loopback clients until a password is set, as Redis does. The HTTP API listens on `127.0.0.1` unless `--http-host` says otherwise, whatever `--host` is.
- **Eavesdropping on the network:** RESP over TLS (`--tls-port`) and HTTPS (`--http-tls`), TLS 1.2 or newer, with PEM or PKCS#12 certificates. Client certificates can be required (`--tls-ca-cert-file`).
- **Password guessing:** failed logins are counted per address across RESP and HTTP; after `--auth-max-failures` (default 10) within a minute, the address is blocked for a minute. Failures and blocks are logged (once per address per minute, so the log can't be flooded). Loopback clients are never blocked.
- **Password disclosure:**
  - only a SHA-256 hash of the password is kept in memory, and the configuration itself can hold just the hash (`sha256:<hex>`, made with `mimic --hash-password`);
  - comparisons run in constant time, and AUTH arguments are masked in debug logs;
  - MIMIC warns about short passwords, password files others can read, and `--password` on the command line;
  - an empty password stops startup.
- **Unauthenticated clients tying up resources:** they must log in within `--auth-timeout` seconds (default 10), get Redis' pre-AUTH limits (10 arguments, 16 KB each), and can't make MIMIC hold more than 256 KB of their input.
- **Web pages in a local browser** reaching the HTTP API or the RESP port:
  - HTTP requires `Content-Type: application/json`, refuses foreign `Origin`s and cross-site `Sec-Fetch-Site` requests, and checks `Host` against DNS rebinding when no password is set;
  - the Bearer token is only accepted with the `Bearer` scheme;
  - replies carry `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`;
  - an HTTP request sent to the RESP port drops the connection.
- **Resource exhaustion by a single client:**
  - caps on value size (`--max-bulk-bytes`), buffered input (`--max-query-buffer`), HTTP body size and JSON nesting depth;
  - replies are streamed with backpressure;
  - HTTP has timeouts (10 s for headers, 30 s per request) and at most 1,000 connections at once.
- **Pathological input:** glob patterns that would take exponential time, huge integer arguments, malformed protocol frames, deeply nested JSON, and names like `__proto__` or `constructor`.
- **The process dying from a full heap:** writes get `-OOM` near the V8 heap limit (`--max-memory-percent`).
- **Log forging:** client-supplied text (command names, error messages quoting them) has control characters escaped in the logs; `CLIENT SETNAME`/`SETINFO` only accept printable characters, so `CLIENT LIST` can't be forged either.
- **Misconfiguration:** numeric options are range-checked, TLS settings must be complete, unknown or essential commands can't be disabled, and a one-line `security:` summary is logged at startup, with warnings for risky setups (no password on a network address, plain text on a network address, running as root/QSECOFR).
- **Destructive or expensive commands for applications that don't need them:** `--disable-commands FLUSHALL,FLUSHDB,KEYS`, for example. Disabled commands behave as unknown everywhere (RESP, HTTP, `MULTI`, `COMMAND`).

## Known limitations

Take these into account when deploying.

| Limitation | Impact | What to do |
|---|---|---|
| **One password, full access** (no users or ACLs) | Any client with the password can use every enabled command in every database. | Disable what applications don't need (`--disable-commands`), and run separate instances for applications that must not see each other's data. |
| **Expensive commands from authenticated clients** (`KEYS *`, `LRANGE 0 -1` on huge lists, `HGETALL` on huge hashes) | They block the server while they run, as in Redis. | `--disable-commands KEYS`, use SCAN; keep values and collections a sensible size; lower `--max-bulk-bytes`. |
| **Certificates are read at startup** | Renewing a certificate needs a restart. | Restart MIMIC after renewing (a cache restart empties it). |
| **No per-address connection limit** | One address can open up to `--max-clients` connections (unauthenticated ones are closed after `--auth-timeout`). | Restrict who can reach the port; lower `--max-clients` if needed. |

## Deployment checklist

**Everywhere:**

- [ ] Keep the default bind address (`127.0.0.1`) unless other machines must connect.
- [ ] If other machines must connect: set a long random password, use TLS (`--tls-port`, and `--port off` so there is no plain-text port), restrict access by firewall, and keep the HTTP API on `127.0.0.1` (or give it `--http-tls`). See the README's "Accepting connections from other machines".
- [ ] Use `--password-file` (or `MIMIC_PASSWORD_FILE`) rather than `--password`, which other users can see in the process list. Consider storing only the hash (`mimic --hash-password`).
- [ ] Disable commands your applications don't use, for example `--disable-commands FLUSHALL,FLUSHDB,KEYS`.
- [ ] Check the `security:` line and any warnings in the startup log.
- [ ] Use a supported Node.js LTS release, and keep it updated.
- [ ] Don't run `--log-level debug` in production: it logs values, which may be sensitive.
- [ ] Size the heap (`--max-old-space-size`) so the `-OOM` guard, not the operating system, decides when the cache is full.

**On IBM i:**

- [ ] Run MIMIC under a **dedicated user profile** of class `*USER` with no special authorities, never under QSECOFR or a profile with `*ALLOBJ`. MIMIC warns if it runs as uid 0.
- [ ] Make the installation directory writable **only by its owner**. Anyone who can change the files in `dist/` can run code as MIMIC's profile.
- [ ] Protect the password file, the TLS key or PKCS#12 file and its passphrase file: `chmod 600`, owned by MIMIC's profile, `*PUBLIC *EXCLUDE`.
- [ ] For TLS, export the certificate with its private key from Digital Certificate Manager as PKCS#12, and use `--tls-pfx-file` with `--tls-key-pass-file`.
- [ ] If the port must be reachable from other systems, bind to one specific interface address instead of `0.0.0.0`, and allow only the hosts that need it (for example with IP packet filtering).
- [ ] Remember that Service Commander keeps MIMIC's log output in its log files; protect them accordingly.
