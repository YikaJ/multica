package execenv

import "fmt"

// BuildCommentReplyInstructions returns the canonical block telling an agent
// how to post its reply for a comment-triggered task. Both the per-turn
// prompt (daemon.buildCommentPrompt) and the CLAUDE.md workflow
// (InjectRuntimeConfig) call this so the trigger comment ID and the
// --parent value cannot drift between surfaces.
//
// The explicit "do not reuse --parent from previous turns" wording exists
// because resumed Claude sessions keep prior turns' tool calls in context
// and will otherwise copy the old --parent UUID forward.
//
// The template is provider-aware. The strong "use stdin / use file" mandate
// originated from #1795 / #1851 to fix Codex's habit of emitting literal
// `\n` escapes inside `--content "..."`. Other providers handle inline
// escaping correctly (the CLI's `util.UnescapeBackslashEscapes` decodes
// `\n` server-side anyway), so they get the original lightweight inline
// template that worked on every platform — including Windows non-ASCII,
// where argv goes through CreateProcessW UTF-16 and bytes survive intact.
//
// Codex on Windows must use `--content-file` because piping a HEREDOC
// through PowerShell 5.1 / cmd.exe re-encodes bytes via the active console
// codepage and drops non-ASCII as `?` before reaching `multica.exe` —
// see issues #2198 / #2236.
func BuildCommentReplyInstructions(provider, issueID, triggerCommentID string) string {
	if triggerCommentID == "" {
		return ""
	}
	if provider == "codex" {
		if runtimeGOOS == "windows" {
			return fmt.Sprintf(
				"If you decide to reply, post it as a comment — always use the trigger comment ID below, "+
					"do NOT reuse --parent values from previous turns in this session.\n\n"+
					"On Windows, write the reply body to a UTF-8 file with your file-write tool, then post it with `--content-file`. "+
					"Do NOT pipe via `--content-stdin` — Windows PowerShell 5.1 and cmd.exe re-encode piped bytes through the active console codepage and silently drop non-ASCII characters as `?`. "+
					"Do NOT use inline `--content`; it is easy to lose formatting or accidentally compress a structured reply into one line.\n\n"+
					"Use this form, preserving the same issue ID and --parent value:\n\n"+
					"    # 1. Write the reply body to a UTF-8 file (e.g. reply.md) with your file-write tool.\n"+
					"    # 2. Then run:\n"+
					"    multica issue comment add %s --parent %s --content-file ./reply.md\n\n"+
					"Do NOT write literal `\\n` escapes to simulate line breaks; the file preserves real newlines.\n",
				issueID, triggerCommentID,
			)
		}
		return fmt.Sprintf(
			"If you decide to reply, post it as a comment — always use the trigger comment ID below, "+
				"do NOT reuse --parent values from previous turns in this session.\n\n"+
				"Always use `--content-stdin` with a HEREDOC for agent-authored issue comments, even when the reply is a single line. "+
				"Do NOT use inline `--content`; it is easy to lose formatting or accidentally compress a structured reply into one line.\n\n"+
				"Use this form, preserving the same issue ID and --parent value:\n\n"+
				"    cat <<'COMMENT' | multica issue comment add %s --parent %s --content-stdin\n"+
				"    First paragraph.\n"+
				"\n"+
				"    Second paragraph.\n"+
				"    COMMENT\n\n"+
				"Do NOT write literal `\\n` escapes to simulate line breaks; the HEREDOC preserves real newlines.\n",
			issueID, triggerCommentID,
		)
	}
	// Non-Codex providers: lightweight inline template, no platform branch.
	// Pre-#1795 default, restored after we found that #1795 / #1851 had
	// expanded a Codex-specific fix into a global mandate that broke
	// Windows non-ASCII for every provider. The CLI decodes `\n` etc.
	// server-side, so escaped multi-line is fine; for richer formatting
	// the agent can still reach for `--content-stdin` (works on Linux /
	// macOS) or `--content-file <path>` (works on every platform), both
	// listed in Available Commands above.
	return fmt.Sprintf(
		"If you decide to reply, post it as a comment — always use the trigger comment ID below, "+
			"do NOT reuse --parent values from previous turns in this session.\n\n"+
			"Use this form, preserving the same issue ID and --parent value:\n\n"+
			"    multica issue comment add %s --parent %s --content \"...\"\n\n"+
			"For multi-line bodies, code blocks, or content with quotes/backticks, prefer `--content-stdin` "+
			"(pipe a HEREDOC) or `--content-file <path>` (read a UTF-8 file). See Available Commands above for the full menu.\n",
		issueID, triggerCommentID,
	)
}
