-- Fails (division by zero, counted by pgbench as a failed transaction) if a snapshot ever shows a wrong total.
-- The divisor depends on the aggregate, so the planner cannot fold it into a constant before the query runs.
SELECT 1 / (CASE WHEN sum(bal) = :expected THEN 1 ELSE 0 END) FROM bank;
