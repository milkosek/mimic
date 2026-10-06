# Test certificates

Self-signed certificates **for the test suite only**. The CA's private key was
deleted after signing, and these files are public: never use them for anything
else, and never add `ca.crt` to a trust store.

- `ca.crt`: test CA
- `server.crt` / `server.key`: server certificate for `localhost`, `127.0.0.1` and `::1`
- `server.p12`: the same, as PKCS#12, passphrase in `pfx-pass.txt`
- `client.crt` / `client.key`: client certificate for mutual-TLS tests
- `untrusted-client.crt` / `untrusted-client.key`: a self-signed client certificate the test CA didn't sign

They are valid until about 2126.
