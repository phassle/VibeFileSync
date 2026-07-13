#!/usr/bin/env node
// ============================================================================
// PROTOTYPE — THROWAWAY. Do not ship. Wayfinder ticket #7.
//
// Question: What are the v1 subcommands and their structured-output contracts?
// Exit codes, --json schema shape/stability, progress streaming vs final
// summary — the agent-drivable contract. Rendered as help-text + example
// invocations + example JSON payloads to react to.
//
// Builds on ADR-0003 (plan/run split, review-first, --yes, NDJSON plan schema)
// and ADR-0002 (per-run flags --allow-empty-source, --ignore-space-check).
// Binary name is a placeholder: `vfs` throughout — react to the name too.
//
// Run: npm run proto:cli    (or: node prototype-cli-surface.mjs)
//
// Tabs:  [1] command grammar — variants G1 / G2 / G3 (←/→)
//        [2] example session — one annotated transcript
//        [3] JSON contracts — run-stream variants P1 / P2 (←/→)
//        [4] exit codes — variants E1 / E2 (←/→)
// ============================================================================

const ESC = "\x1b[";
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const inv = (s) => `${ESC}7m${s}${ESC}0m`;
const cyan = (s) => `${ESC}36m${s}${ESC}0m`;
const green = (s) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s) => `${ESC}33m${s}${ESC}0m`;

const $ = (s) => green("$ ") + bold(s); // an invocation line

// ---------- Tab 1: command grammar variants ----------------------------------

const grammarG1 = () => `
${bold("G1 — frequent verbs top-level, pair management namespaced")}

${$("vfs --help")}
  ${bold("vfs")} — one-way file sync with SafetyNet (macOS)

  ${bold("USAGE")}   vfs <command> [args] [flags]

  ${bold("SYNC")}    ${cyan("plan")} <pair>      show what a run would do (dry-run, never mutates)
          ${cyan("run")} <pair>       execute the plan  ${dim("(prints plan, asks y/N; --yes skips)")}
          ${cyan("status")} <pair>    last run result, pending journal, SafetyNet size
          ${cyan("history")} <pair>   past runs, newest first
  ${bold("PAIRS")}   ${cyan("pair add")} <name> <source> <dest> --mode mirror|update
          ${cyan("pair list")}        all configured Folder pairs
          ${cyan("pair remove")} <name>
  ${bold("SAFETY")}  ${cyan("prune")} <pair>     delete SafetyNet Run folders  ${dim("(--keep-last N | --older-than 30d | <run-ts>)")}
  ${bold("UI")}      ${cyan("tui")} [<pair>]     interactive review TUI

  ${bold("RUN FLAGS")}  --yes  --json  --permanent-delete  --allow-empty-source  --ignore-space-check

${dim("Rationale: plan/run/status are the everyday verbs — no namespace tax on the")}
${dim("hot path. Setup (pair …) and destructive housekeeping (prune) read as scoped.")}`;

const grammarG2 = () => `
${bold("G2 — everything namespaced (kubectl-style)")}

${$("vfs --help")}
  ${bold("USAGE")}   vfs <noun> <verb> [args] [flags]

  ${cyan("pair")}       add | list | remove
  ${cyan("sync")}       plan <pair> | run <pair> | status <pair> | history <pair>
  ${cyan("safetynet")}  list <pair> | prune <pair>
  ${cyan("tui")}        [<pair>]

  ${$("vfs sync plan projects-t7 --json")}
  ${$("vfs sync run projects-t7 --yes")}
  ${$("vfs safetynet prune projects-t7 --keep-last 5")}

${dim("Rationale: uniform grammar, trivially discoverable and tab-completable;")}
${dim("agents never guess where a verb lives. Cost: every hot-path call is longer.")}`;

const grammarG3 = () => `
${bold("G3 — flat verbs (rsync/git hybrid, tersest)")}

${$("vfs --help")}
  ${bold("USAGE")}   vfs <verb> [args] [flags]

  ${cyan("add")} <name> <src> <dest> --mode …     ${cyan("plan")} <pair>       ${cyan("prune")} <pair>
  ${cyan("ls")}                                   ${cyan("run")} <pair>        ${cyan("tui")} [<pair>]
  ${cyan("rm")} <name>                            ${cyan("log")} <pair>        ${cyan("status")} <pair>

  ${$("vfs add projects-t7 ~/Projects /Volumes/T7/Projects-mirror --mode mirror")}
  ${$("vfs plan projects-t7 && vfs run projects-t7 --yes")}

${dim("Rationale: shortest to type and script. Cost: ls/rm/log collide with shell")}
${dim("muscle memory and read ambiguously in scripts (rm what?); grows badly.")}`;

// ---------- Tab 2: example session --------------------------------------------

const session = () => `
${bold("Example session — G1 grammar, human output")}   ${dim("(formats per ADR-0003)")}

${$("vfs pair add projects-t7 ~/Projects /Volumes/T7/Projects-mirror --mode mirror")}
  Added Folder pair ${bold("projects-t7")}  ${cyan("Mirror")}
  source  /Users/per/Projects        ${dim("volume UUID 6C0B…A1 pinned")}
  dest    /Volumes/T7/Projects-mirror ${dim("volume UUID 9F2E…77 pinned (exFAT)")}

${$("vfs plan projects-t7")}
  ${dim("→ grouped-by-operation dry-run diff (ADR-0003 variant B)")}

${$("vfs run projects-t7")}
  ${dim("→ prints the same plan, then:")}
  Run 5 copy (4.5 MB) · 3 update · 2 delete?  SafetyNet first → _SafetyNet/2026-07-13T09-41-22/
  ${bold("Proceed? [y/N]")} y
  ${green("✓ done")} — 5 copied · 3 updated · 2 deleted · 0 failed   ${dim("(12.4 s)")}

${$("vfs status projects-t7")}
  last run   2026-07-13T09-41-22  ${green("clean")}  ${dim("(10 ok / 0 failed)")}
  journal    no pending actions
  SafetyNet  3 Run folders · 214 MB   ${dim("oldest 2026-06-02")}

${$("vfs history projects-t7")}
  2026-07-13T09-41-22  ${green("clean")}   10 actions  4.6 MB   ${dim("run 01J2QG5D7NXKQ8")}
  2026-07-08T18-02-51  ${yellow("partial")} 84 actions  1.2 GB  ${dim("2 failed — see vfs status")}

${$("vfs prune projects-t7 --keep-last 2")}
  Deleting 1 Run folder (2026-06-02, 96 MB) — keeping the newest 2. ${bold("Proceed? [y/N]")}

${dim("Open: is `vfs restore <pair> <run-ts> [path]` a v1 command, or is restore")}
${dim("manual copy-back from the visible _SafetyNet tree? Nothing decided yet.")}
${dim("Open: per-run excludes on the CLI (--exclude <glob>), or TUI-only?")}`;

// ---------- Tab 3: JSON contracts ----------------------------------------------

const jsonP1 = () => `
${bold("P1 — full NDJSON event stream")}   ${$("vfs run projects-t7 --yes --json")}

{"type":"run_start","schema":"vibefilesync.run/v1","run_id":"01J2QG5D7NXKQ8","pair":"projects-t7","mode":"mirror","dry_run":false,"plan":{"copy":5,"update":3,"delete":2}}
{"type":"action_start","op":"copy","path":"site/assets/hero.png","bytes":4718592}
{"type":"progress","path":"site/assets/hero.png","bytes_done":2359296,"bytes_total":4718592}
{"type":"action_done","op":"copy","path":"site/assets/hero.png","result":"ok","verified":true,"ms":1240}
{"type":"action_done","op":"update","path":"docs/notes.md","result":"ok","verified":true,"safety_net":"_SafetyNet/2026-07-13T09-41-22/docs/notes.md","ms":85}
${dim("… one action_start/action_done per action; progress only for large files …")}
{"type":"summary","result":"clean","ok":10,"failed":0,"bytes_written":4787039,"safety_net_dir":"_SafetyNet/2026-07-13T09-41-22/","ms":12400}

${dim("Same envelope as the plan stream (ADR-0003). Agents get live per-file state:")}
${dim("progress bars, early failure reaction, tail -f-able logs. Plan and run share")}
${dim("the type/op/path vocabulary. Cost: chattier; consumers must skip event types.")}`;

const jsonP2 = () => `
${bold("P2 — summary-only JSON")}   ${$("vfs run projects-t7 --yes --json")}

${dim("stderr (human, live):")}  copying site/assets/hero.png … 4.5 MB  ${dim("(throttled progress)")}
${dim("stdout (machine, once, at exit):")}

{
  "schema": "vibefilesync.run/v1",
  "run_id": "01J2QG5D7NXKQ8",
  "pair": "projects-t7",
  "result": "clean",
  "ok": 10, "failed": 0,
  "failures": [],
  "bytes_written": 4787039,
  "safety_net_dir": "_SafetyNet/2026-07-13T09-41-22/",
  "ms": 12400
}

${dim("One parseable object per run — the cron/CI sweet spot: exit code + one JSON")}
${dim("line. Cost: no live state; an agent watching a 200 GB run sees nothing until")}
${dim("the end (status would need polling from another process).")}

${bold("Common to both:")} ${dim("`schema` field versions every payload; additive changes only")}
${dim("within /v1 — field removals or meaning changes bump to /v2. pair list and")}
${dim("history --json reuse the same convention (vibefilesync.pairs/v1, .history/v1).")}`;

// ---------- Tab 4: exit codes ----------------------------------------------------

const exitE1 = () => `
${bold("E1 — rich taxonomy")}   ${dim("scripts branch on the class without parsing JSON")}

  ${bold("0")}   clean         every planned action executed and verified
  ${bold("1")}   partial       run finished but ≥1 action failed  ${dim("(details in JSON/status)")}
  ${bold("2")}   precondition  a run guard aborted before any mutation ${dim("(ADR-0002: UUID, empty-source, space)")}
  ${bold("3")}   blocked plan  plan contains error actions and --yes was given ${dim("(ADR-0003: errors block)")}
  ${bold("4")}   interrupted   signal/crash mid-run — journal holds state, rerun resumes
  ${bold("64")}  usage         bad arguments/flags ${dim("(BSD sysexits convention)")}

  ${dim("cron example:")} ${bold("vfs run p --yes --json || case $? in 2) … ;; 4) vfs run p --yes ;; esac")}

${dim("Rationale: agent-first — the common branches (retry on 4, alert on 2/3,")}
${dim("investigate on 1) need no JSON parsing. Cost: a contract we must keep stable.")}`;

const exitE2 = () => `
${bold("E2 — minimal")}   ${dim("unix-classic: 0 / 1 / 2")}

  ${bold("0")}   success       run clean (or plan printed, or command succeeded)
  ${bold("1")}   failure       anything else — partial, guard abort, blocked, interrupted
  ${bold("2")}   usage         bad arguments/flags

  ${dim("Detail lives only in the JSON summary:")} "result": "clean" | "partial" |
  "precondition_abort" | "blocked_plan" | "interrupted"

${dim("Rationale: nothing to memorize, impossible to get wrong. Cost: every script")}
${dim("that wants to branch must parse JSON (or grep), even for 'retry after crash'.")}`;

// ---------- app shell --------------------------------------------------------------

const state = { tab: 0, v: [0, 0, 0, 0] };
const TABS = [
  { name: "1:grammar", variants: [grammarG1, grammarG2, grammarG3], keys: "G1/G2/G3" },
  { name: "2:session", variants: [session], keys: "" },
  { name: "3:json", variants: [jsonP1, jsonP2], keys: "P1/P2" },
  { name: "4:exit codes", variants: [exitE1, exitE2], keys: "E1/E2" },
];

const render = () => {
  const t = TABS[state.tab];
  const tabBar = TABS.map((x, i) => (i === state.tab ? inv(` ${x.name} `) : dim(` ${x.name} `))).join(" ");
  const vhint = t.variants.length > 1 ? `${bold("←/→")} ${dim("switch " + t.keys)}   ` : "";
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(
    [
      dim("PROTOTYPE — CLI surface (ticket #7). Throwaway. Binary name `vfs` is a placeholder."),
      tabBar,
      t.variants[state.v[state.tab] % t.variants.length](),
      "",
      `${vhint}${bold("1-4")} ${dim("switch tab")}   ${bold("q")} ${dim("quit")}`,
      "",
    ].join("\n")
  );
};

const onKey = (key) => {
  if (key === "q" || key === "\x03") { process.stdout.write("\x1b[2J\x1b[H"); process.exit(0); }
  if (["1", "2", "3", "4"].includes(key)) state.tab = Number(key) - 1;
  const n = TABS[state.tab].variants.length;
  if (key === "\x1b[C") state.v[state.tab] = (state.v[state.tab] + 1) % n;
  if (key === "\x1b[D") state.v[state.tab] = (state.v[state.tab] + n - 1) % n;
  render();
};

if (!process.stdin.isTTY) {
  // smoke-test mode: PROTO_TAB=1..4 PROTO_VARIANT=0..
  if (process.env.PROTO_TAB) state.tab = Number(process.env.PROTO_TAB) - 1;
  if (process.env.PROTO_VARIANT) state.v = state.v.map(() => Number(process.env.PROTO_VARIANT));
  render();
  process.exit(0);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", onKey);
render();
