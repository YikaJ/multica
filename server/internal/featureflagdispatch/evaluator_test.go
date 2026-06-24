package featureflagdispatch

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/featureflag"
)

func TestEvaluateForRuntimeWritesDaemonBoundSnapshot(t *testing.T) {
	t.Parallel()

	provider := featureflag.NewStaticProvider()
	provider.Set(RuntimeBriefSlimFlag, featureflag.Rule{Default: true})
	evaluator := NewEvaluator(featureflag.NewService(provider))

	snapshot := evaluator.EvaluateForRuntime(context.Background(), testRuntime("00000000-0000-0000-0000-000000000001", "daemon-a"))
	if snapshot == nil {
		t.Fatal("snapshot is nil")
	}
	if snapshot.Version != defaultSnapshotVersion {
		t.Fatalf("snapshot version = %d, want %d", snapshot.Version, defaultSnapshotVersion)
	}
	if got := snapshot.Flags[RuntimeBriefSlimFlag]; got != "on" {
		t.Fatalf("%s = %q, want on", RuntimeBriefSlimFlag, got)
	}
	if len(snapshot.Flags) != len(DaemonBoundFlags) {
		t.Fatalf("snapshot flags = %#v, want exactly daemon-bound registry", snapshot.Flags)
	}
}

func TestEvaluateForRuntimeIncludesRuntimeContext(t *testing.T) {
	t.Parallel()

	provider := featureflag.NewStaticProvider()
	provider.Set(RuntimeBriefSlimFlag, featureflag.Rule{
		Default: false,
		Allow:   []string{"daemon-allowed"},
		AllowBy: "daemon_id",
	})
	evaluator := NewEvaluator(featureflag.NewService(provider))

	snapshot := evaluator.EvaluateForRuntime(context.Background(), testRuntime("00000000-0000-0000-0000-000000000002", "daemon-allowed"))
	if got := snapshot.Flags[RuntimeBriefSlimFlag]; got != "on" {
		t.Fatalf("%s = %q, want on for daemon_id allow", RuntimeBriefSlimFlag, got)
	}
}

func TestEvaluateForRuntimeWorkspacePercentRollout(t *testing.T) {
	t.Parallel()

	provider := featureflag.NewStaticProvider()
	provider.Set(RuntimeBriefSlimFlag, featureflag.Rule{
		Default: false,
		Percent: &featureflag.PercentRollout{
			Percent: 25,
			By:      "workspace_id",
		},
	})
	evaluator := NewEvaluator(featureflag.NewService(provider))

	var enabled int
	for i := 0; i < 1000; i++ {
		workspaceID := fmt.Sprintf("00000000-0000-0000-0000-%012x", i)
		snapshot := evaluator.EvaluateForRuntime(context.Background(), testRuntime(workspaceID, "daemon-a"))
		if snapshot.Flags[RuntimeBriefSlimFlag] == "on" {
			enabled++
		}
	}
	if enabled < 200 || enabled > 300 {
		t.Fatalf("25%% workspace rollout enabled %d/1000 workspaces, want roughly 250", enabled)
	}
}

func testRuntime(workspaceID, daemonID string) db.AgentRuntime {
	return db.AgentRuntime{
		ID:          util.MustParseUUID("10000000-0000-0000-0000-000000000001"),
		WorkspaceID: util.MustParseUUID(workspaceID),
		DaemonID:    pgtype.Text{String: daemonID, Valid: daemonID != ""},
	}
}
