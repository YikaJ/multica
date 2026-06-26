DROP TABLE IF EXISTS chat_agent_session;

DROP INDEX IF EXISTS idx_agent_task_queue_chat_thread_pending;
DROP INDEX IF EXISTS idx_chat_message_session_thread;

ALTER TABLE agent_task_queue
  DROP COLUMN IF EXISTS chat_thread_id;

ALTER TABLE chat_thread
  DROP CONSTRAINT IF EXISTS chat_thread_root_message_fkey;

ALTER TABLE chat_message
  DROP COLUMN IF EXISTS chat_thread_id;

DROP TABLE IF EXISTS chat_thread;

DROP INDEX IF EXISTS idx_chat_session_scope;

ALTER TABLE chat_session
  DROP COLUMN IF EXISTS superseded_by_chat_session_id,
  DROP COLUMN IF EXISTS external_ref,
  DROP COLUMN IF EXISTS visibility,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS scope_id,
  DROP COLUMN IF EXISTS scope_type;
