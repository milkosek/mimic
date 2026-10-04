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
- getting around authentication, the pre-AUTH limits, or the HTTP API's browser protections (Origin, `Sec-Fetch-Site`, Host checks, Content-Type);
- reading or changing data without the password;
- running code on the server, reading or writing files, or reaching anything outside MIMIC's own data;
- secrets leaking into logs or error messages (other than with `--log-level debug`, which logs values by design);
- a client using far more memory or CPU than its limits should allow, in a way that hurts other clients.

**Out of scope**, because they are documented behaviour (see [Security model](#security-model)):

- anything someone can do **with** the password, including `FLUSHALL` and reading every database;
- reading traffic on the network: there is no TLS yet;
- problems when MIMIC is exposed to a network without a password, despite the warning;
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

What MIMIC already protects against:

- **Web pages in a local browser** reaching the HTTP API or the RESP port:
  - HTTP requires `Content-Type: application/json`, refuses foreign `Origin`s and cross-site `Sec-Fetch-Site` requests, and checks `Host` against DNS rebinding when no password is set;
  - an HTTP request sent to the RESP port drops the connection.
- **Unauthenticated clients** buffering large amounts of data: Redis' pre-AUTH limits apply (10 arguments, 16 KB each).
- **Resource exhaustion by a single client:** caps on value size (`--max-bulk-bytes`) and buffered input (`--max-query-buffer`); replies are streamed with backpressure.
- **Pathological input:** glob patterns that would take exponential time, huge integer arguments, malformed protocol frames.
- **The process dying from a full heap:** writes get `-OOM` near the V8 heap limit (`--max-memory-percent`).
- **Password handling:**
  - passwords are compared in constant time;
  - an empty password stops startup;
  - passwords are masked in debug logs.

## Known limitations

These are known and planned. Until they're addressed, take them into account when deploying.

| Limitation | Impact | Until it's fixed |
|---|---|---|
| **No TLS** on RESP or HTTP | The password and all data cross the network in clear text. | Keep MIMIC on the same machine as its clients, or tunnel it (SSH port forwarding, stunnel). |
| **No "protected mode"** | Binding to a network address without a password only logs a warning; Redis refuses outside clients in that case. | Never set `MIMIC_HOST` to anything but loopback without a password. |
| **The HTTP API binds to the same address as RESP** by default | Exposing RESP with `MIMIC_HOST=0.0.0.0` exposes HTTP too. | Set `MIMIC_HTTP_HOST=127.0.0.1`, or `--http-port off` if you don't use HTTP. |
| **No limit on password attempts**, and failed attempts aren't logged | Someone who can reach the port can guess passwords as fast as the network allows (as with Redis). | Use a long random password (32+ characters), and restrict who can reach the port. |
| **Unauthenticated connections have no time limit** (up to `--max-clients`, default 10,000) | Many idle unauthenticated connections can use memory and connection slots. | Restrict who can reach the port; lower `--max-clients`; set `--idle-timeout`. |
| **One all-powerful password**, no read-only or per-command restriction | Any client with the password can `FLUSHALL`. | Separate instances per application. |

## Deployment checklist

**Everywhere:**

- [ ] Keep the default bind address (`127.0.0.1`) unless other machines must connect.
- [ ] If other machines must connect: set a long random password, put TLS in front (tunnel), restrict access by firewall, set `MIMIC_HTTP_HOST=127.0.0.1` or `--http-port off`.
- [ ] Use `--password-file` (or `MIMIC_PASSWORD_FILE`) rather than `--password`, which other users can see in the process list.
- [ ] Use a supported Node.js LTS release, and keep it updated.
- [ ] Don't run `--log-level debug` in production: it logs values, which may be sensitive.
- [ ] Size the heap (`--max-old-space-size`) so the `-OOM` guard, not the operating system, decides when the cache is full.

**On IBM i:**

- [ ] Run MIMIC under a **dedicated user profile** of class `*USER` with no special authorities, never under QSECOFR or a profile with `*ALLOBJ`.
- [ ] Make the installation directory writable **only by its owner**. Anyone who can change the files in `dist/` can run code as MIMIC's profile.
- [ ] Protect the password file: `chmod 600`, owned by MIMIC's profile, `*PUBLIC *EXCLUDE`.
- [ ] If the port must be reachable from other systems, bind to one specific interface address instead of `0.0.0.0`, and allow only the hosts that need it (for example with IP packet filtering).
- [ ] Remember that Service Commander keeps MIMIC's log output in its log files; protect them accordingly.
