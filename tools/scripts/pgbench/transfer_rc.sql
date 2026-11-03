-- READ COMMITTED transfer in one statement (both rows), used as the background write load.
\set a random(1, 100)
\set b random(1, 100)
\set amt random(1, 50)
BEGIN;
UPDATE bank SET bal = bal + CASE WHEN id = :a THEN -:amt ELSE :amt END WHERE id IN (:a, :b) AND :a <> :b;
INSERT INTO ledger (a, b, amt) VALUES (:a, :b, :amt);
END;
