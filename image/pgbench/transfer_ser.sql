-- SERIALIZABLE money transfer between two of a few hot accounts (conflicts and retries are expected).
\set a random(1, 20)
\set b random(1, 20)
\set amt random(1, 50)
BEGIN ISOLATION LEVEL SERIALIZABLE;
UPDATE bank SET bal = bal - :amt WHERE id = :a;
UPDATE bank SET bal = bal + :amt WHERE id = :b;
INSERT INTO ledger (a, b, amt) VALUES (:a, :b, :amt);
END;
