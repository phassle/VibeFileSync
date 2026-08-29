// Sandcastle orchestration for VibeFileSync - macOS host runs.
//
// Why noSandbox and not docker(): vibesync links macOS libSystem directly
// (copyfile(3), F_FULLFSYNC via fcntl). It does not compile, link or test
// inside a Linux container, so the agents run on the ai-server host itself,
// isolated per issue by a git worktree instead of by a container.
//
// Phase 1 (Plan):             one agent reads open issues labelled
//                             "Sandcastle", builds a dependency graph and
//                             emits a <plan> JSON of unblocked issues.
// Phase 2 (Execute + Review): per issue, a worktree-backed sandbox runs the
//                             implementer, then the reviewer on the same
//                             branch. Capped by SANDCASTLE_CONCURRENCY.
// Phase 3 (Merge):            one agent merges the finished branches into
//                             the branch you started from.
//
// Usage:
//   npm run sandcastle

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { z } from "zod";

type PlannedIssue = { id: string; title: string; branch: string };

const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Plan -> execute -> merge cycles before stopping. */
const MAX_ITERATIONS = Number(process.env.SANDCASTLE_MAX_ITERATIONS ?? 10);

/** Issue pipelines running at once. Each one is a full cargo build, so this is
 *  bounded by cores and RAM on the server, not by the agent. */
const CONCURRENCY = Number(process.env.SANDCASTLE_CONCURRENCY ?? 2);

/** Model alias handed to Claude Code. Aliases survive model releases. */
const MODEL = process.env.SANDCASTLE_MODEL ?? "opus";

/** noSandbox deliberately does not pass --dangerously-skip-permissions, so an
 *  unattended run needs this set. The agent then has your user's rights on the
 *  server. Set it to "auto" for AI-mediated per-tool approval instead. */
const PERMISSION_MODE = (process.env.SANDCASTLE_PERMISSION_MODE ??
  "bypassPermissions") as "auto" | "bypassPermissions" | "acceptEdits";

/** cargo target dir, kept per branch and outside the worktree. Worktrees are
 *  recreated between runs, so a stable path per branch preserves the build
 *  cache. Separate dirs also stop concurrent pipelines from queueing on a
 *  single cargo lock. */
const TARGET_CACHE_ROOT =
  process.env.SANDCASTLE_TARGET_CACHE ??
  join(homedir(), ".cache", "vibesync-sandcastle");

const agent = sandcastle.claudeCode(MODEL, { permissionMode: PERMISSION_MODE });

/** The branch the run started from. Merges land here, diffs are taken against it.
 *
 *  Passed to the prompts as BASE_BRANCH, never as TARGET_BRANCH. TARGET_BRANCH
 *  and SOURCE_BRANCH are built-in prompt arguments in @ai-hero/sandcastle:
 *  supplying either through promptArgs throws a PromptError, and the framework
 *  injects TARGET_BRANCH itself. Its injected value differs by call site --
 *  sandcastle.run() gets the host branch, but sandbox.run() gets the worktree's
 *  own branch, so inside the implementer and the reviewer {{TARGET_BRANCH}}
 *  equals {{BRANCH}} and a diff against it is empty. Hence BASE_BRANCH for
 *  anything that must name the branch we forked from. */
const TARGET_BRANCH = execFileSync(
  "git",
  ["rev-parse", "--abbrev-ref", "HEAD"],
  { encoding: "utf8" },
).trim();

const sandboxFor = (branch?: string) =>
  noSandbox({
    env: {
      CARGO_TARGET_DIR: join(
        TARGET_CACHE_ROOT,
        (branch ?? "planner").replace(/[^A-Za-z0-9._-]/g, "-"),
      ),
    },
  });

/** Warm the cargo registry before the agent starts, so its first build is not a
 *  cold dependency fetch inside an iteration timeout. */
const hooks = {
  sandbox: {
    onSandboxReady: [{ command: "cargo fetch --locked", timeoutMs: 300_000 }],
  },
};

/** Run tasks with a fixed number in flight. Rejections are captured per task,
 *  the same shape Promise.allSettled returns. */
async function allSettledLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, tasks.length)) },
    async () => {
      while (next < tasks.length) {
        const index = next++;
        try {
          results[index] = { status: "fulfilled", value: await tasks[index]!() };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

console.log(
  `Sandcastle on ${TARGET_BRANCH} - model ${MODEL}, concurrency ${CONCURRENCY}, permissions ${PERMISSION_MODE}`,
);

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    sandbox: sandboxFor(),
    name: "planner",
    maxIterations: 1,
    agent,
    promptFile: "./.sandcastle/plan-prompt.md",
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues as PlannedIssue[];

  if (issues.length === 0) {
    console.log("No unblocked Sandcastle issues to work on. Exiting.");
    break;
  }

  console.log(`Planning complete. ${issues.length} issue(s) queued:`);
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} -> ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  // -------------------------------------------------------------------------
  const settled = await allSettledLimit(
    issues.map((issue) => async () => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: sandboxFor(issue.branch),
        hooks,
      });

      try {
        const implement = await sandbox.run({
          name: `implementer:${issue.id}`,
          maxIterations: 100,
          agent,
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
            BASE_BRANCH: TARGET_BRANCH,
          },
        });

        if (implement.commits.length === 0) return implement;

        const review = await sandbox.run({
          name: `reviewer:${issue.id}`,
          maxIterations: 1,
          agent,
          promptFile: "./.sandcastle/review-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            BRANCH: issue.branch,
            BASE_BRANCH: TARGET_BRANCH,
          },
        });

        return {
          ...review,
          commits: [...implement.commits, ...review.commits],
        };
      } finally {
        await sandbox.close();
      }
    }),
    CONCURRENCY,
  );

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  x ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) console.log(`  ${branch}`);

  if (completedBranches.length === 0) {
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: sandboxFor(TARGET_BRANCH),
    name: "merger",
    maxIterations: 1,
    agent,
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
