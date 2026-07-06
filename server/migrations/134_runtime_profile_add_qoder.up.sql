-- DROP/ADD CHECK CONSTRAINT briefly needs ACCESS EXCLUSIVE on runtime_profile.
-- During a rolling API startup, an old pod can hold a normal transaction lock
-- long enough for startup migrations to appear hung. Bound that wait so the new
-- pod exits and retries instead of sitting unready indefinitely; the migration
-- is not recorded unless both ALTER statements complete.
SET lock_timeout = '5s';

ALTER TABLE runtime_profile DROP CONSTRAINT IF EXISTS runtime_profile_protocol_family_check;

-- Widen the whitelist to include Qoder so Qoder CN (`qoderclicn`) users can base
-- a custom runtime profile on the existing Qoder backend (launches
-- `<command> --yolo --acp`) instead of misrouting through Kiro/ACP with
-- incompatible arguments (#4883). NOT VALID mirrors migration 126 so a
-- historical Gemini row it intentionally tolerated does not block the upgrade.
ALTER TABLE runtime_profile ADD CONSTRAINT runtime_profile_protocol_family_check
    CHECK (protocol_family IN (
        'claude',
        'codebuddy',
        'codex',
        'copilot',
        'opencode',
        'openclaw',
        'hermes',
        'pi',
        'cursor',
        'kimi',
        'kiro',
        'antigravity',
        'qoder'
    )) NOT VALID;

RESET lock_timeout;
