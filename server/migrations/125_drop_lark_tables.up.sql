-- Drop the lark_* tables. MUL-3515 generalized them into channel_* in
-- migration 124 and the Go cutover has landed (the lark package now reads and
-- writes only channel_*), so the old tables are dead. Per the design (§5:
-- replace, do not keep both) the old path is removed rather than left in place.
--
-- Dropped in dependency order — every other lark_* table has a foreign key to
-- lark_installation, so it goes last. The down migration recreates the schema
-- (structure only; the data already lives in channel_*).
DROP TABLE IF EXISTS lark_binding_token;
DROP TABLE IF EXISTS lark_outbound_card_message;
DROP TABLE IF EXISTS lark_inbound_audit;
DROP TABLE IF EXISTS lark_inbound_message_dedup;
DROP TABLE IF EXISTS lark_user_binding;
DROP TABLE IF EXISTS lark_chat_session_binding;
DROP TABLE IF EXISTS lark_installation;
