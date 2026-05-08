package execenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestBuildCommentReplyInstructionsCodexLinux pins that the strong
// "MUST use --content-stdin + HEREDOC" mandate is alive for Codex on
// non-Windows hosts. Codex's habit of emitting literal `\n` inside
// `--content "..."` is the original reason this mandate exists
// (#1795 / #1851); on Linux/macOS stdin is the right answer.
//
// Not parallel: mutates the package-level runtimeGOOS.
func TestBuildCommentReplyInstructionsCodexLinux(t *testing.T) {
	saved := runtimeGOOS
	t.Cleanup(func() { runtimeGOOS = saved })
	runtimeGOOS = "linux"

	issueID := "11111111-1111-1111-1111-111111111111"
	triggerID := "22222222-2222-2222-2222-222222222222"

	got := BuildCommentReplyInstructions("codex", issueID, triggerID)

	for _, want := range []string{
		"multica issue comment add " + issueID + " --parent " + triggerID + " --content-stdin",
		"Always use `--content-stdin`",
		"even when the reply is a single line",
		"<<'COMMENT'",
		"Do NOT write literal `\\n` escapes to simulate line breaks",
		"do NOT reuse --parent values from previous turns",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("codex/linux reply instructions missing %q\n---\n%s", want, got)
		}
	}

	if strings.Contains(got, "--content \"...\"") {
		t.Fatalf("codex reply instructions should not offer inline --content form\n---\n%s", got)
	}
}

// TestBuildCommentReplyInstructionsNonCodexUsesInline pins that every
// non-Codex provider gets the lightweight pre-#1795 inline template,
// regardless of host OS. The "MUST stdin" mandate was originally a
// Codex-specific fix that #1795 / #1851 accidentally spread to every
// provider — and on Windows that spread broke non-ASCII bytes via the
// console codepage (#2198 / #2236). Non-Codex providers handle inline
// escaping correctly and the CLI server-decodes `\n` etc., so the
// inline template works on every platform including Windows non-ASCII
// (argv goes through CreateProcessW UTF-16).
//
// Not parallel: mutates the package-level runtimeGOOS.
func TestBuildCommentReplyInstructionsNonCodexUsesInline(t *testing.T) {
	saved := runtimeGOOS
	t.Cleanup(func() { runtimeGOOS = saved })

	issueID := "11111111-1111-1111-1111-111111111111"
	triggerID := "22222222-2222-2222-2222-222222222222"

	for _, host := range []string{"linux", "darwin", "windows"} {
		for _, provider := range []string{"claude", "opencode", "openclaw", "hermes", "kimi", "kiro", "cursor", "gemini"} {
			name := provider + "/" + host
			t.Run(name, func(t *testing.T) {
				runtimeGOOS = host
				got := BuildCommentReplyInstructions(provider, issueID, triggerID)

				for _, want := range []string{
					"multica issue comment add " + issueID + " --parent " + triggerID + " --content \"...\"",
					"do NOT reuse --parent values from previous turns",
					"If you decide to reply",
				} {
					if !strings.Contains(got, want) {
						t.Errorf("%s reply instructions missing %q\n---\n%s", name, want, got)
					}
				}

				// Non-Codex providers must NOT receive the Codex-specific
				// "MUST stdin" mandate or its HEREDOC template, even on
				// Linux/macOS — that was the over-spread of #1795 / #1851.
				for _, banned := range []string{
					"Always use `--content-stdin`",
					"<<'COMMENT'",
					"--parent " + triggerID + " --content-stdin",
					"--parent " + triggerID + " --content-file",
				} {
					if strings.Contains(got, banned) {
						t.Errorf("%s reply instructions still steers at codex template: %q\n---\n%s", name, banned, got)
					}
				}
			})
		}
	}
}

func TestBuildCommentReplyInstructionsEmptyWhenNoTrigger(t *testing.T) {
	t.Parallel()

	if got := BuildCommentReplyInstructions("codex", "issue-id", ""); got != "" {
		t.Fatalf("expected empty string when triggerCommentID is empty, got %q", got)
	}
	if got := BuildCommentReplyInstructions("claude", "issue-id", ""); got != "" {
		t.Fatalf("expected empty string when triggerCommentID is empty, got %q", got)
	}
}

// Pins runtimeGOOS to "linux" so the helper output is deterministic.
// Provider is "claude" — exercises the non-codex inline path through
// InjectRuntimeConfig end-to-end. Not parallel: mutates runtimeGOOS.
func TestInjectRuntimeConfigCommentTriggerUsesHelper(t *testing.T) {
	saved := runtimeGOOS
	t.Cleanup(func() { runtimeGOOS = saved })
	runtimeGOOS = "linux"

	dir := t.TempDir()

	issueID := "11111111-1111-1111-1111-111111111111"
	triggerID := "22222222-2222-2222-2222-222222222222"

	ctx := TaskContextForEnv{
		IssueID:          issueID,
		TriggerCommentID: triggerID,
	}
	if err := InjectRuntimeConfig(dir, "claude", ctx); err != nil {
		t.Fatalf("InjectRuntimeConfig failed: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatalf("read CLAUDE.md: %v", err)
	}

	s := string(content)
	for _, want := range []string{
		triggerID,
		"multica issue comment add " + issueID + " --parent " + triggerID,
		"do NOT reuse --parent values from previous turns",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("CLAUDE.md missing %q", want)
		}
	}
}

// TestBuildCommentReplyInstructionsCodexWindowsUsesContentFile pins that on
// Windows hosts the Codex per-turn reply template points at
// `--content-file` instead of `--content-stdin`. PowerShell 5.1 / cmd.exe
// re-encode piped HEREDOC bytes through the active console codepage and
// silently drop non-ASCII characters as `?` before they reach
// `multica.exe` (issues #2198 / #2236).
//
// Not parallel: mutates the package-level runtimeGOOS.
func TestBuildCommentReplyInstructionsCodexWindowsUsesContentFile(t *testing.T) {
	saved := runtimeGOOS
	t.Cleanup(func() { runtimeGOOS = saved })

	issueID := "11111111-1111-1111-1111-111111111111"
	triggerID := "22222222-2222-2222-2222-222222222222"

	t.Run("codex/windows points at --content-file", func(t *testing.T) {
		runtimeGOOS = "windows"
		got := BuildCommentReplyInstructions("codex", issueID, triggerID)
		for _, want := range []string{
			"multica issue comment add " + issueID + " --parent " + triggerID + " --content-file",
			"On Windows, write the reply body to a UTF-8 file",
			"Do NOT pipe via `--content-stdin`",
			"silently drop non-ASCII characters as `?`",
		} {
			if !strings.Contains(got, want) {
				t.Errorf("codex/windows reply instructions missing %q\n---\n%s", want, got)
			}
		}
		for _, banned := range []string{
			"<<'COMMENT'",
			"--parent " + triggerID + " --content-stdin",
			"cat <<",
		} {
			if strings.Contains(got, banned) {
				t.Errorf("codex/windows reply instructions should not contain %q\n---\n%s", banned, got)
			}
		}
	})
}

// TestInjectRuntimeConfigCodexWindowsCommentTriggerHasNoStdin asserts the
// end-to-end AGENTS.md surface for a Codex comment-triggered task on a
// Windows daemon: the Codex-Specific paragraph + the per-turn reply
// template are file-first, with no remaining `--content-stdin` directive
// that would override the Windows file mandate. The Available Commands
// section is now neutral on every platform (post-rollback of #1795 /
// #1851), so it is allowed to mention `--content-stdin` as one of the
// three input modes.
func TestInjectRuntimeConfigCodexWindowsCommentTriggerHasNoStdin(t *testing.T) {
	saved := runtimeGOOS
	t.Cleanup(func() { runtimeGOOS = saved })
	runtimeGOOS = "windows"

	issueID := "11111111-1111-1111-1111-111111111111"
	triggerID := "22222222-2222-2222-2222-222222222222"
	ctx := TaskContextForEnv{
		IssueID:          issueID,
		TriggerCommentID: triggerID,
	}

	dir := t.TempDir()
	if err := InjectRuntimeConfig(dir, "codex", ctx); err != nil {
		t.Fatalf("InjectRuntimeConfig failed: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		t.Fatalf("read AGENTS.md: %v", err)
	}
	s := string(data)

	for _, want := range []string{
		"multica issue comment add " + issueID + " --parent " + triggerID + " --content-file",
		"--content-file",
		"--description-file",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("AGENTS.md missing %q\n---\n%s", want, s)
		}
	}

	// The per-turn reply template and the Codex-specific paragraph must
	// not direct the agent at stdin on Windows. Pin prescriptive
	// substrings rather than bare flag names so anti-prescriptive prose
	// like "do NOT pipe via `--content-stdin`" doesn't trip the ban.
	for _, banned := range []string{
		"--parent " + triggerID + " --content-stdin",
		"always use `--content-stdin` with a HEREDOC, even for short single-line replies",
	} {
		if strings.Contains(s, banned) {
			t.Errorf("AGENTS.md still steers codex at stdin on Windows: %q\n---\n%s", banned, s)
		}
	}
}
