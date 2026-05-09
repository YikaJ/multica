package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fetchTimeline issues a GET /timeline request and returns the decoded entries
// + HTTP status. The endpoint returns a flat array of TimelineEntry sorted by
// (created_at, id) ascending (oldest first); see ListTimeline / #1929.
func fetchTimeline(t *testing.T, issueID string) ([]TimelineEntry, int) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("GET", "/api/issues/"+issueID+"/timeline", nil)
	req = withURLParam(req, "id", issueID)
	testHandler.ListTimeline(w, req)
	var entries []TimelineEntry
	if w.Code == http.StatusOK {
		json.NewDecoder(w.Body).Decode(&entries)
	}
	return entries, w.Code
}

// createIssueForTimeline returns a freshly-created issue id and registers a
// cleanup so its timeline rows are deleted after the test.
func createIssueForTimeline(t *testing.T, title string) string {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  title,
		"status": "todo",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	json.NewDecoder(w.Body).Decode(&issue)
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, issue.ID)
		testPool.Exec(ctx, `DELETE FROM comment WHERE issue_id = $1`, issue.ID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issue.ID)
	})
	return issue.ID
}

// seedTimelineEntries inserts <commentN> comments + <activityN> activities for
// the given issue with ascending timestamps. Returns the inserted ids in the
// order they were inserted (chronologically ascending).
func seedTimelineEntries(t *testing.T, issueID string, commentN, activityN int) (commentIDs, activityIDs []string) {
	t.Helper()
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Duration(commentN+activityN) * time.Minute)

	for i := 0; i < commentN; i++ {
		var id string
		ts := base.Add(time.Duration(i) * time.Minute)
		if err := testPool.QueryRow(ctx, `
			INSERT INTO comment (issue_id, workspace_id, author_type, author_id, content, type, created_at, updated_at)
			VALUES ($1, $2, 'member', $3, $4, 'comment', $5, $5)
			RETURNING id
		`, issueID, testWorkspaceID, testUserID, fmt.Sprintf("comment %d", i), ts).Scan(&id); err != nil {
			t.Fatalf("seed comment %d: %v", i, err)
		}
		commentIDs = append(commentIDs, id)
	}
	for i := 0; i < activityN; i++ {
		var id string
		ts := base.Add(time.Duration(commentN+i) * time.Minute)
		if err := testPool.QueryRow(ctx, `
			INSERT INTO activity_log (workspace_id, issue_id, actor_type, actor_id, action, details, created_at)
			VALUES ($1, $2, 'member', $3, 'status_changed', '{"from":"todo","to":"in_progress"}'::jsonb, $4)
			RETURNING id
		`, testWorkspaceID, issueID, testUserID, ts).Scan(&id); err != nil {
			t.Fatalf("seed activity %d: %v", i, err)
		}
		activityIDs = append(activityIDs, id)
	}
	return
}

func TestListTimeline_ReturnsAllEntriesAscending(t *testing.T) {
	issueID := createIssueForTimeline(t, "All entries test")
	commentIDs, _ := seedTimelineEntries(t, issueID, 5, 0)

	entries, status := fetchTimeline(t, issueID)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	// Issue creation seeds an "issue created" activity, so we expect
	// (1 issue-created activity) + 5 seeded comments. The seeded comments
	// are timestamped strictly after the auto-activity, so the comment
	// order alone is what we assert.
	commentEntries := []TimelineEntry{}
	for _, e := range entries {
		if e.Type == "comment" {
			commentEntries = append(commentEntries, e)
		}
	}
	if got, want := len(commentEntries), len(commentIDs); got != want {
		t.Fatalf("comment count = %d, want %d", got, want)
	}
	for i, e := range commentEntries {
		if e.ID != commentIDs[i] {
			t.Errorf("entry %d: id = %s, want %s", i, e.ID, commentIDs[i])
		}
	}
}

func TestListTimeline_MergesCommentsAndActivities(t *testing.T) {
	issueID := createIssueForTimeline(t, "Merged entries test")
	seedTimelineEntries(t, issueID, 3, 2)

	entries, status := fetchTimeline(t, issueID)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	// Verify chronological non-decreasing order across types.
	for i := 1; i < len(entries); i++ {
		if entries[i-1].CreatedAt > entries[i].CreatedAt {
			t.Errorf("not chronological at %d: %q then %q",
				i, entries[i-1].CreatedAt, entries[i].CreatedAt)
		}
	}
	// At least: 1 auto issue-created activity + 3 comments + 2 activities = 6.
	if len(entries) < 6 {
		t.Fatalf("entries = %d, want at least 6", len(entries))
	}
}

func TestListTimeline_EmptyIssue(t *testing.T) {
	issueID := createIssueForTimeline(t, "Empty timeline test")
	entries, status := fetchTimeline(t, issueID)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	// Issue creation seeds one "issue created" activity; no comments.
	for _, e := range entries {
		if e.Type == "comment" {
			t.Errorf("unexpected comment entry: %+v", e)
		}
	}
}
