ALTER TABLE chat_message ADD COLUMN thread_task_id UUID;

UPDATE chat_message
SET thread_task_id = task_id
WHERE task_id IS NOT NULL;

CREATE INDEX idx_chat_message_session_thread_task
  ON chat_message(chat_session_id, thread_task_id, created_at)
  WHERE thread_task_id IS NOT NULL;
