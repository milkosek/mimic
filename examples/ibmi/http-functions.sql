-- Using MIMIC from Db2 for i SQL (and embedded SQL in RPG/COBOL) through the
-- HTTP API and the QSYS2 HTTP functions.
--
-- The QSYS2.HTTP_* functions need a recent Technology Refresh (IBM i 7.4 TR5 /
-- 7.3 TR11 or later). Check the options syntax against the documentation for
-- your release.
--
-- Leave out the Authorization header if MIMIC runs without a password.

-- Cache a value for 5 minutes (SET key value EX 300)
VALUES QSYS2.HTTP_POST(
  'http://127.0.0.1:6380/command',
  '["SET", "customer:1001", "{\"name\":\"ACME Corp\",\"credit\":5000}", "EX", 300]',
  '{"headers": {"Content-Type": "application/json", "Authorization": "Bearer change-me"}}');

-- Read it back. The result is {"result": "..."}; JSON_TABLE extracts the value.
SELECT J.CACHED
  FROM JSON_TABLE(
         QSYS2.HTTP_POST(
           'http://127.0.0.1:6380/command',
           '["GET", "customer:1001"]',
           '{"headers": {"Content-Type": "application/json", "Authorization": "Bearer change-me"}}'),
         '$' COLUMNS(CACHED VARCHAR(32000) PATH '$.result')) AS J;

-- Several commands in one round trip. A pipeline runs without interruption,
-- so it is also atomic.
VALUES QSYS2.HTTP_POST(
  'http://127.0.0.1:6380/pipeline',
  '[["INCR", "orders:today"], ["EXPIRE", "orders:today", 86400], ["GET", "orders:today"]]',
  '{"headers": {"Content-Type": "application/json", "Authorization": "Bearer change-me"}}');

-- REST style: fetch a key with its type and remaining TTL (404 if missing, so use
-- HTTP_GET_VERBOSE when a miss must not be an SQL error).
SELECT *
  FROM TABLE(QSYS2.HTTP_GET_VERBOSE(
         'http://127.0.0.1:6380/keys/customer%3A1001',
         '{"headers": {"Authorization": "Bearer change-me"}}'));
