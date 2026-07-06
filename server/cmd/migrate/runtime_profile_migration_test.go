package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/migrations"
)

func TestRuntimeProfileQoderMigrationSetsLockTimeout(t *testing.T) {
	migrationDir, err := migrations.ResolveDir()
	if err != nil {
		t.Fatalf("resolve migrations dir: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(migrationDir, "134_runtime_profile_add_qoder.up.sql"))
	if err != nil {
		t.Fatalf("read qoder migration: %v", err)
	}
	sql := string(body)
	setIdx := strings.Index(sql, "SET lock_timeout = '5s';")
	dropIdx := strings.Index(sql, "ALTER TABLE runtime_profile DROP CONSTRAINT")
	resetIdx := strings.LastIndex(sql, "RESET lock_timeout;")
	if setIdx == -1 {
		t.Fatal("qoder migration does not set lock_timeout")
	}
	if resetIdx == -1 {
		t.Fatal("qoder migration does not reset lock_timeout")
	}
	if dropIdx == -1 {
		t.Fatal("qoder migration does not drop the existing runtime_profile constraint")
	}
	if !(setIdx < dropIdx && dropIdx < resetIdx) {
		t.Fatalf("qoder migration timeout wrapper order is wrong: set=%d drop=%d reset=%d", setIdx, dropIdx, resetIdx)
	}
}

func TestRuntimeProfileQoderMigrationLockTimeout(t *testing.T) {
	pool := openTestPool(t)

	suffix := fmt.Sprintf("%d_%d", time.Now().UnixNano(), rand.Uint32())
	schema := "migrate_lock_timeout_" + suffix
	schemaIdent := pgx.Identifier{schema}.Sanitize()
	tableIdent := pgx.Identifier{schema, "runtime_profile"}.Sanitize()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if _, err := pool.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA %s`, schemaIdent)); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, fmt.Sprintf(`DROP SCHEMA IF EXISTS %s CASCADE`, schemaIdent)); err != nil {
			t.Logf("drop schema %s: %v", schema, err)
		}
	})

	if _, err := pool.Exec(ctx, fmt.Sprintf(`
		CREATE TABLE %s (
			id BIGSERIAL PRIMARY KEY,
			protocol_family TEXT NOT NULL
		);
		ALTER TABLE %s ADD CONSTRAINT runtime_profile_protocol_family_check
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
				'antigravity'
			)) NOT VALID;
		INSERT INTO %s (protocol_family) VALUES ('codex');
	`, tableIdent, tableIdent, tableIdent)); err != nil {
		t.Fatalf("setup runtime_profile table: %v", err)
	}

	migrationDir, err := migrations.ResolveDir()
	if err != nil {
		t.Fatalf("resolve migrations dir: %v", err)
	}
	migrationBody, err := os.ReadFile(filepath.Join(migrationDir, "134_runtime_profile_add_qoder.up.sql"))
	if err != nil {
		t.Fatalf("read qoder migration: %v", err)
	}
	testMigration := filepath.Join(t.TempDir(), "134_runtime_profile_add_qoder.up.sql")
	if err := os.WriteFile(testMigration, []byte(fmt.Sprintf("SET search_path TO %s;\n%s", schemaIdent, migrationBody)), 0o600); err != nil {
		t.Fatalf("write test migration: %v", err)
	}

	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire lock holder: %v", err)
	}
	defer holder.Release()
	tx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatalf("begin lock holder tx: %v", err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, fmt.Sprintf("LOCK TABLE %s IN ACCESS SHARE MODE", tableIdent)); err != nil {
		t.Fatalf("hold runtime_profile access share lock: %v", err)
	}

	start := time.Now()
	err = runMigrations(ctx, pool, runOptions{
		Direction:             "up",
		Files:                 []string{testMigration},
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       int64(rand.Uint64()&0x7fffffffffffffff) | 1,
	})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("runMigrations succeeded while runtime_profile DDL lock was blocked")
	}
	if !strings.Contains(err.Error(), "lock timeout") {
		t.Fatalf("runMigrations error = %v, want lock timeout", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("migration lock wait took %s, want fail-fast under 10s", elapsed)
	}

	var recorded int
	if err := pool.QueryRow(ctx,
		fmt.Sprintf(`SELECT count(*) FROM %s`, pgx.Identifier{schema, "schema_migrations"}.Sanitize()),
	).Scan(&recorded); err != nil {
		t.Fatalf("read schema_migrations count: %v", err)
	}
	if recorded != 0 {
		t.Fatalf("schema_migrations recorded failed migration count = %d, want 0", recorded)
	}
}
