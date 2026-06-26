DROP INDEX IF EXISTS idx_chat_message_session_thread_task;
ALTER TABLE chat_message DROP COLUMN IF EXISTS thread_task_id;
