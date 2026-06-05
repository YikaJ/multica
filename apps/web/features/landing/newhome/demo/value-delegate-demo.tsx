"use client";

// Value #2 — "Delegate to agents like teammates". A scripted flow that plays
// the real delegation loop end to end, then repeats:
//   0. New-issue composer, the Assignee dropdown open with Claude Code picked
//   1. Issue created, assigned to Claude Code (Create pressed)
//   2. The issue page — the agent is working
//   3. The agent posts its result as a comment, status moves to In Review
// Presentational (no providers); styled to match the product.

import { useEffect, useState } from "react";
import { Check, GitPullRequest, ListTodo, SignalHigh, User } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { AGENTS, MEMBERS } from "./mock-data";
import { ValueDemoFrame } from "./value-demo-frame";

const CLAUDE = AGENTS.find((a) => a.id === "a-claude")!;
const TITLE = "Add rate limiting to the public API";

type Phase =
  | { scene: "create"; dropdown: boolean; assigned: boolean; creating: boolean }
  | { scene: "issue"; working: boolean };

const PHASES: Phase[] = [
  { scene: "create", dropdown: true, assigned: false, creating: false },
  { scene: "create", dropdown: false, assigned: true, creating: true },
  { scene: "issue", working: true },
  { scene: "issue", working: false },
];
const DURATIONS = [3000, 1500, 2700, 4200];

export function ValueDelegateDemo() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(
      () => setI((n) => (n + 1) % PHASES.length),
      DURATIONS[i],
    );
    return () => window.clearTimeout(t);
  }, [i]);

  const p = PHASES[i]!;
  return (
    <ValueDemoFrame height={548}>
      <div className="pointer-events-none h-full w-full select-none bg-white">
        {p.scene === "create" ? (
          <CreateScene
            dropdown={p.dropdown}
            assigned={p.assigned}
            creating={p.creating}
          />
        ) : (
          <IssueScene working={p.working} />
        )}
      </div>
    </ValueDemoFrame>
  );
}

function avatarImg(src: string, cls: string) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={cls} />;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
}

function PropChip({
  active,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1.5 text-[12.5px] font-medium",
        active
          ? "border-[var(--brand)]/40 bg-[var(--brand)]/[0.06] text-[#0a0d12]"
          : "border-[#0a0d12]/12 text-[#0a0d12]/65",
      )}
    >
      {children}
    </span>
  );
}

function CreateScene({
  dropdown,
  assigned,
  creating,
}: {
  dropdown: boolean;
  assigned: boolean;
  creating: boolean;
}) {
  return (
    <div className="newhome-fade flex h-full flex-col px-9 py-8">
      <div className="text-[13px] font-semibold text-[#0a0d12]/55">New issue</div>

      <div className="mt-3 rounded-[6px] border border-[#0a0d12]/10 px-4 pb-4 pt-3.5">
        <div className="text-[16px] font-semibold text-[#0a0d12]">{TITLE}</div>
        <div className="mt-1.5 text-[13px] leading-6 text-[#0a0d12]/45">
          Token-bucket limiter on the gateway — 100 req/min per key, 429 +
          Retry-After when exceeded.
        </div>

        <div className="mt-4 flex items-center gap-2">
          <PropChip>
            <ListTodo className="size-3.5 text-[#0a0d12]/40" /> Todo
          </PropChip>
          <PropChip>
            <SignalHigh className="size-3.5 text-amber-500" /> High
          </PropChip>
          <div className="relative">
            <PropChip active={dropdown || assigned}>
              {assigned ? (
                <>
                  {avatarImg(CLAUDE.avatar_url ?? "", "size-4 rounded-full")} Claude
                  Code
                </>
              ) : (
                <>
                  <User className="size-3.5 text-[#0a0d12]/40" /> Assignee
                </>
              )}
            </PropChip>
            {dropdown && <AssigneeDropdown />}
          </div>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-end gap-3 pt-5">
        <span className="text-[12px] tabular-nums text-[#0a0d12]/30">⌘ ↵</span>
        <span
          className={cn(
            "rounded-[8px] bg-[#0a0d12] px-3.5 py-2 text-[13px] font-semibold text-white transition-transform",
            creating && "scale-[0.97] ring-2 ring-[var(--brand)]/30",
          )}
        >
          Create issue
        </span>
      </div>
    </div>
  );
}

function AssigneeDropdown() {
  return (
    <div className="newhome-pop absolute left-0 top-full z-10 mt-1.5 w-[256px] rounded-[6px] border border-[#0a0d12]/10 bg-white p-1 shadow-[0_10px_30px_rgba(10,13,18,0.14)]">
      <div className="px-2 py-1.5 text-[12px] text-[#0a0d12]/40">Assign to…</div>
      {AGENTS.map((a) => {
        const picked = a.id === "a-claude";
        return (
          <div
            key={a.id}
            className={cn(
              "flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px]",
              picked ? "bg-[var(--brand)]/[0.08] text-[#0a0d12]" : "text-[#0a0d12]/70",
            )}
          >
            {avatarImg(a.avatar_url ?? "", "size-[18px] rounded-full")}
            <span className="flex-1 truncate">{a.name}</span>
            {picked && <Check className="size-3.5 text-[var(--brand)]" />}
          </div>
        );
      })}
      <div className="my-1 border-t border-[#0a0d12]/8" />
      {MEMBERS.map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px] text-[#0a0d12]/70"
        >
          <span className="flex size-[18px] items-center justify-center rounded-full bg-[#0a0d12]/[0.07] text-[9px] font-semibold text-[#0a0d12]/55">
            {initials(m.name)}
          </span>
          <span>{m.name}</span>
        </div>
      ))}
    </div>
  );
}

function IssueScene({ working }: { working: boolean }) {
  return (
    <div className="newhome-fade flex h-full flex-col px-9 py-8">
      <div className="text-[12px] font-medium text-[#0a0d12]/40">MUL-137</div>
      <div className="mt-1 text-[18px] font-semibold leading-snug text-[#0a0d12]">
        {TITLE}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-semibold",
            working
              ? "bg-amber-500/12 text-amber-700"
              : "bg-violet-500/12 text-violet-700",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              working ? "bg-amber-500" : "bg-violet-500",
            )}
          />
          {working ? "In Progress" : "In Review"}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#0a0d12]/10 px-2 py-1 text-[12px] font-medium text-[#0a0d12]/70">
          {avatarImg(CLAUDE.avatar_url ?? "", "size-4 rounded-full")} Claude Code
        </span>
      </div>

      <div className="mt-5 flex-1 border-t border-[#0a0d12]/8 pt-5">
        {working ? <WorkingBlock /> : <ResultComment />}
      </div>
    </div>
  );
}

function WorkingBlock() {
  return (
    <div className="newhome-fade flex gap-3">
      {avatarImg(CLAUDE.avatar_url ?? "", "size-7 rounded-full ring-1 ring-[#0a0d12]/8")}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-[#0a0d12]">
            Claude Code
          </span>
          <span className="newhome-typing flex gap-0.5">
            <span className="size-1.5 rounded-full bg-[#0a0d12]/30" />
            <span className="size-1.5 rounded-full bg-[#0a0d12]/30" />
            <span className="size-1.5 rounded-full bg-[#0a0d12]/30" />
          </span>
        </div>
        <div className="mt-2.5 space-y-2 text-[12.5px] text-[#0a0d12]/60">
          <div className="flex items-center gap-2">
            <Check className="size-3.5 text-emerald-500" />
            Read <code className="text-[12px]">server/internal/gateway/router.go</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="size-3.5 rounded-full border-2 border-[var(--brand)]/30 border-t-[var(--brand)] [animation:spin_0.9s_linear_infinite]" />
            Writing <code className="text-[12px]">ratelimit.go</code> — token bucket,
            429 + Retry-After
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultComment() {
  return (
    <div className="newhome-fade">
      <div className="mb-3 text-[12px] font-medium text-[#0a0d12]/40">Activity</div>
      <div className="flex gap-3">
        {avatarImg(
          CLAUDE.avatar_url ?? "",
          "size-7 rounded-full ring-1 ring-[#0a0d12]/8",
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-[#0a0d12]">
              Claude Code
            </span>
            <span className="rounded-full bg-[var(--brand)]/12 px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--brand)]">
              Agent
            </span>
            <span className="text-[12px] text-[#0a0d12]/40">just now</span>
          </div>
          <div className="mt-1.5 rounded-[6px] rounded-tl-[2px] border border-[#0a0d12]/8 bg-[#0a0d12]/[0.02] px-3.5 py-2.5 text-[13px] leading-6 text-[#0a0d12]/80">
            Done. Added a token-bucket limiter on the gateway — 100 req/min per key,{" "}
            <code className="text-[12.5px]">X-RateLimit-*</code> headers, and a 429 +
            Retry-After path. Opened a PR with tests.
            <span className="mt-2 flex w-fit items-center gap-1.5 rounded-[6px] border border-[#0a0d12]/8 bg-white px-2 py-1 text-[12px] font-medium text-[#0a0d12]/70">
              <GitPullRequest className="size-3.5 text-[#0a0d12]/45" /> PR #3721 ·
              gateway: token-bucket rate limiting
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
