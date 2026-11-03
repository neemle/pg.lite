-- Rows are locked in random order, so concurrent transfers deadlock; the server must detect and break each one.
\set a random(1, 8)
\set b random(1, 8)
\set amt random(1, 50)
BEGIN;
UPDATE bank SET bal = bal - :amt WHERE id = :a;
UPDATE bank SET bal = bal + :amt WHERE id = :b;
INSERT INTO ledger (a, b, amt) VALUES (:a, :b, :amt);
END;
