-- Node soft-delete: bi-temporal parity with edges.valid_to.
-- A closed node (valid_to set) is forgotten: excluded from recall, extraction context and the graph view,
-- but the row (and its history) stays in the DB.
alter table nodes add column if not exists valid_to date;
create index if not exists nodes_valid_to_idx on nodes (valid_to);
