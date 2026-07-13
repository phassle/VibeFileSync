#!/usr/bin/env node
// ============================================================================
// PROTOTYPE — THROWAWAY. Do not ship. Wayfinder ticket #6.
//
// Question: What does a comprehensible Dry-run diff look like (CLI human and
// --json forms), and is execution auto-run or always-review-first? For the
// TUI: is a FreeFileSync-style dual-pane worth it, or is an action-list
// clearer?
//
// Assumption: the real product is Rust + ratatui. This Node mock explores
// output shape and interaction only — both are runtime-agnostic.
//
// Run: npm run proto:dryrun    (or: node prototype-dryrun-review.mjs)
//
// Tabs:  [1] CLI human output — variants A / B / C (press a/b/c or ←/→)
//        [2] CLI --json output — variants J1 (document) / J2 (NDJSON stream)
//        [3] TUI review flow — dual-pane vs action-list (v), include/exclude
//            (space), Enter → review-first confirm screen
// ============================================================================

// ---------- fake sync plan (Mirror mode, APFS source → exFAT destination) ----

const PAIR = {
  name: "projects-t7",
  source: "/Users/per/Projects",
  dest: "/Volumes/T7/Projects-mirror",
  mode: "Mirror",
  destFs: "exFAT",
};

const RUN_TS = "2026-07-13T09-41-22";

const ACTIONS = [
  { op: "mkdir",  path: "site/assets/",                     reason: "new directory" },
  { op: "copy",   path: "site/assets/hero.png",    bytes: 4718592, reason: "new file" },
  { op: "copy",   path: "site/assets/logo.svg",    bytes: 18432,   reason: "new file" },
  { op: "copy",   path: "site/index.html",         bytes: 12288,   reason: "new file" },
  { op: "copy",   path: "notes/2026-07-ideas.md",  bytes: 3140,    reason: "new file" },
  { op: "update", path: "docs/notes.md",           bytes: 8721,  oldBytes: 8102,  reason: "size + mtime differ" },
  { op: "update", path: "docs/spec/safety-net.md", bytes: 24576, oldBytes: 24576, reason: "mtime differs" },
  { op: "update", path: "app/Cargo.toml",          bytes: 1290,  oldBytes: 1244,  reason: "size + mtime differ" },
  { op: "delete", path: "scratch/old-benchmarks.csv", oldBytes: 91234, reason: "absent in source" },
  { op: "delete", path: "scratch/",                    reason: "absent in source" },
  { op: "error",  path: "app/target-link",             reason: "symlink — exFAT destination cannot hold symlinks (v1 hard error)" },
];

const SCAN = { scanned: 1482, unchanged: 1466, excluded: 9 };

// ---------- tiny ANSI helpers ------------------------------------------------

const ESC = "\x1b[";
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const inv = (s) => `${ESC}7m${s}${ESC}0m`;
const fg = (c, s) => `${ESC}${c}m${s}${ESC}0m`;
const green = (s) => fg(32, s);
const yellow = (s) => fg(33, s);
const red = (s) => fg(31, s);
const cyan = (s) => fg(36, s);

const fmtBytes = (n) => {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < 2);
  return `${n.toFixed(1)} ${units[u]}`;
};

const pad = (s, w) => {
  const len = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return len >= w ? s : s + " ".repeat(w - len);
};

const OP_STYLE = {
  copy:   { glyph: "+", color: green,  label: "copy"   },
  mkdir:  { glyph: "+", color: green,  label: "mkdir"  },
  update: { glyph: "~", color: yellow, label: "update" },
  delete: { glyph: "-", color: red,    label: "delete" },
  error:  { glyph: "!", color: red,    label: "error"  },
};

const summarize = (actions) => {
  const by = (op) => actions.filter((a) => a.op === op);
  const sum = (as, k) => as.reduce((t, a) => t + (a[k] ?? 0), 0);
  return {
    copies: by("copy").length + by("mkdir").length,
    copyBytes: sum(by("copy"), "bytes"),
    updates: by("update").length,
    updateBytes: sum(by("update"), "bytes"),
    deletes: by("delete").length,
    errors: by("error").length,
    safetyNetObjects: by("update").length + by("delete").length,
    safetyNetBytes: sum(by("update"), "oldBytes") + sum(by("delete"), "oldBytes"),
  };
};

// ---------- Tab 1: CLI human output — three variants -------------------------

const cliHeader = () =>
  `${bold("DRY-RUN")}  ${PAIR.name}  ${cyan(PAIR.mode)}  ${PAIR.source} ${dim("→")} ${PAIR.dest} ${dim(`(${PAIR.destFs})`)}\n`;

const safetyNote = (a) =>
  a.op === "update" ? dim(`(replaces ${fmtBytes(a.oldBytes)} → SafetyNet)`)
  : a.op === "delete" ? dim("(→ SafetyNet)")
  : a.op === "error" ? red(a.reason)
  : "";

// Variant A — flat ledger: one line per action in scan order, summary footer.
const renderCliA = () => {
  const lines = [cliHeader()];
  for (const a of ACTIONS) {
    const st = OP_STYLE[a.op];
    lines.push(
      ` ${st.color(st.glyph)} ${pad(st.label, 7)} ${pad(a.path, 32)} ${pad(fmtBytes(a.bytes ?? a.oldBytes), 9)} ${safetyNote(a)}`
    );
  }
  const s = summarize(ACTIONS);
  lines.push("");
  lines.push(dim(` ${SCAN.scanned.toLocaleString()} scanned · ${SCAN.unchanged.toLocaleString()} unchanged · ${SCAN.excluded} excluded by filter`));
  lines.push(
    ` ${green(`${s.copies} copy (${fmtBytes(s.copyBytes)})`)} · ${yellow(`${s.updates} update`)} · ${red(`${s.deletes} delete`)} · ${red(`${s.errors} error`)}`
  );
  lines.push(dim(` SafetyNet: ${s.safetyNetObjects} objects (${fmtBytes(s.safetyNetBytes)}) → _SafetyNet/${RUN_TS}/`));
  return lines.join("\n");
};

// Variant B — grouped by operation: summary first, then sections.
const renderCliB = () => {
  const s = summarize(ACTIONS);
  const lines = [cliHeader()];
  lines.push(
    ` ${bold("Plan:")} ${green(`${s.copies} copy`)} · ${yellow(`${s.updates} update`)} · ${red(`${s.deletes} delete`)} · ${red(`${s.errors} error`)}   ${dim("(dry-run — nothing written)")}\n`
  );
  const section = (title, actions, note) => {
    if (!actions.length) return;
    lines.push(` ${bold(title)}${note ? "  " + dim(note) : ""}`);
    for (const a of actions)
      lines.push(`   ${pad(a.path, 34)} ${pad(fmtBytes(a.bytes ?? a.oldBytes), 9)} ${dim(a.reason)}`);
    lines.push("");
  };
  section(green(`COPY — ${s.copies} new (${fmtBytes(s.copyBytes)})`), ACTIONS.filter((a) => a.op === "copy" || a.op === "mkdir"));
  section(yellow(`UPDATE — ${s.updates} changed`), ACTIONS.filter((a) => a.op === "update"), `old versions → _SafetyNet/${RUN_TS}/`);
  section(red(`DELETE — ${s.deletes} removed`), ACTIONS.filter((a) => a.op === "delete"), `archived → _SafetyNet/${RUN_TS}/`);
  section(red(`ERRORS — ${s.errors}`), ACTIONS.filter((a) => a.op === "error"));
  lines.push(dim(` ${SCAN.scanned.toLocaleString()} scanned · ${SCAN.unchanged.toLocaleString()} unchanged · ${SCAN.excluded} excluded by filter`));
  return lines.join("\n");
};

// Variant C — tree view mirroring the directory structure.
const buildTree = () => {
  const root = {};
  for (const a of ACTIONS) {
    const parts = a.path.replace(/\/$/, "").split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      node.children ??= {};
      node.children[key] ??= {};
      node = node.children[key];
      if (i === parts.length - 1) node.action = a;
    }
  }
  return root;
};

const renderTree = (node, prefix, lines) => {
  const entries = Object.entries(node.children ?? {});
  entries.forEach(([name, child], i) => {
    const last = i === entries.length - 1;
    const branch = last ? "└── " : "├── ";
    const a = child.action;
    const st = a ? OP_STYLE[a.op] : null;
    const label = a
      ? `${st.color(st.glyph)} ${name}${a.path.endsWith("/") ? "/" : ""} ${dim(fmtBytes(a.bytes ?? a.oldBytes))}${a.op === "error" ? " " + red("← " + a.reason) : ""}`
      : `${name}/`;
    lines.push(dim(prefix + branch) + label);
    renderTree(child, prefix + (last ? "    " : "│   "), lines);
  });
};

const renderCliC = () => {
  const lines = [cliHeader(), ` ${PAIR.source}`];
  renderTree(buildTree(), " ", lines);
  const s = summarize(ACTIONS);
  lines.push("");
  lines.push(
    ` ${green(`+ ${s.copies} copy`)} · ${yellow(`~ ${s.updates} update`)} · ${red(`- ${s.deletes} delete`)} · ${red(`! ${s.errors} error`)}  ${dim(`· ${SCAN.unchanged.toLocaleString()} unchanged not shown`)}`
  );
  return lines.join("\n");
};

// ---------- Tab 2: --json output — two framings -------------------------------

const jsonAction = (a) => ({
  op: a.op,
  path: a.path,
  reason: a.reason,
  ...(a.bytes != null && { bytes: a.bytes }),
  ...(a.oldBytes != null && { old_bytes: a.oldBytes }),
  ...((a.op === "update" || a.op === "delete") && {
    safety_net: `_SafetyNet/${RUN_TS}/${a.path}`,
  }),
});

const renderJson1 = () => {
  const s = summarize(ACTIONS);
  const doc = {
    schema: "vibefilesync.plan/v1",
    run_id: "01J2QG5D7NXKQ8",
    dry_run: true,
    pair: { name: PAIR.name, source: PAIR.source, dest: PAIR.dest, mode: PAIR.mode.toLowerCase(), dest_fs: PAIR.destFs },
    scanned: SCAN.scanned,
    unchanged: SCAN.unchanged,
    excluded: SCAN.excluded,
    actions: [jsonAction(ACTIONS[1]), jsonAction(ACTIONS[5]), jsonAction(ACTIONS[8]), jsonAction(ACTIONS[10])],
    summary: { copy: s.copies, update: s.updates, delete: s.deletes, error: s.errors, bytes_to_write: s.copyBytes + s.updateBytes, safety_net_dir: `_SafetyNet/${RUN_TS}/` },
  };
  const out = JSON.stringify(doc, null, 2)
    .replace('"actions": [', '"actions": [        // 4 of 11 shown — full list in real output');
  return [
    bold("Variant J1 — single JSON document") + dim("  (vfs plan projects-t7 --json)"),
    "",
    out,
    "",
    dim("Whole plan as one parseable document. Simple for agents (`jq .summary`),"),
    dim("but a 100k-action plan must be held in memory before anything prints."),
  ].join("\n");
};

const renderJson2 = () => {
  const s = summarize(ACTIONS);
  const lines = [
    bold("Variant J2 — NDJSON stream") + dim("  (vfs plan projects-t7 --json)"),
    "",
    JSON.stringify({ type: "plan_start", schema: "vibefilesync.plan/v1", run_id: "01J2QG5D7NXKQ8", dry_run: true, pair: PAIR.name, mode: PAIR.mode.toLowerCase() }),
  ];
  for (const a of [ACTIONS[1], ACTIONS[5], ACTIONS[8], ACTIONS[10]])
    lines.push(JSON.stringify({ type: "action", ...jsonAction(a) }));
  lines.push(dim("… one line per action — 11 total …"));
  lines.push(JSON.stringify({ type: "summary", copy: s.copies, update: s.updates, delete: s.deletes, error: s.errors, safety_net_dir: `_SafetyNet/${RUN_TS}/` }));
  lines.push("");
  lines.push(dim("One JSON object per line: streams as the scan runs, constant memory,"));
  lines.push(dim("agents can act on rows before the plan finishes. Slightly more parse code."));
  return lines.join("\n");
};

// ---------- Tab 3: TUI review flow --------------------------------------------

const tuiState = {
  cursor: 0,
  excluded: new Set(),  // indexes into ACTIONS
  variant: 0,           // 0 = dual-pane, 1 = action-list
  screen: "review",     // review | confirm | done
};

const checkbox = (i) => (tuiState.excluded.has(i) ? dim("[ ]") : green("[x]"));

const renderTuiDualPane = () => {
  const lines = [];
  lines.push(dim(" inc ") + bold(pad(" SOURCE  " + PAIR.source, 42)) + bold("    ") + bold(pad("DESTINATION  " + PAIR.dest, 40)));
  lines.push(dim(" " + "─".repeat(92)));
  ACTIONS.forEach((a, i) => {
    const st = OP_STYLE[a.op];
    const cur = i === tuiState.cursor;
    const sz = fmtBytes(a.bytes);
    const oldSz = fmtBytes(a.oldBytes);
    let left, mid, right;
    if (a.op === "copy" || a.op === "mkdir") { left = `${a.path} ${dim(sz)}`; mid = green("+>"); right = dim("—"); }
    else if (a.op === "update") { left = `${a.path} ${dim(sz)}`; mid = yellow("~>"); right = `${a.path} ${dim(oldSz + " → SafetyNet")}`; }
    else if (a.op === "delete") { left = dim("—"); mid = red("-x"); right = `${a.path} ${dim("→ SafetyNet")}`; }
    else { left = `${a.path}`; mid = red("!!"); right = red("symlink → exFAT: hard error"); }
    let row = ` ${checkbox(i)} ${pad(left, 40)} ${mid}  ${pad(right, 42)}`;
    if (cur) row = inv(row.replace(/\x1b\[[0-9;]*m/g, ""));
    lines.push(row);
  });
  return lines;
};

const renderTuiActionList = () => {
  const lines = [];
  lines.push(dim(" inc  op       path                                size       note"));
  lines.push(dim(" " + "─".repeat(92)));
  ACTIONS.forEach((a, i) => {
    const st = OP_STYLE[a.op];
    const cur = i === tuiState.cursor;
    let row = ` ${checkbox(i)}  ${st.color(pad(st.glyph + " " + st.label, 8))} ${pad(a.path, 35)} ${pad(fmtBytes(a.bytes ?? a.oldBytes), 10)} ${safetyNote(a)}`;
    if (cur) row = inv(row.replace(/\x1b\[[0-9;]*m/g, ""));
    lines.push(row);
  });
  return lines;
};

const renderTuiReview = () => {
  const included = ACTIONS.filter((_, i) => !tuiState.excluded.has(i));
  const s = summarize(included);
  const variantName = tuiState.variant === 0 ? "dual-pane" : "action-list";
  const lines = [
    ` ${bold("REVIEW")} ${PAIR.name} ${cyan(PAIR.mode)}  ${dim("· layout: " + variantName + " (v to switch)")}`,
    "",
    ...(tuiState.variant === 0 ? renderTuiDualPane() : renderTuiActionList()),
    "",
    ` ${bold("Will run:")} ${green(s.copies + " copy")} · ${yellow(s.updates + " update")} · ${red(s.deletes + " delete")}` +
      (s.errors ? red(`  ⚠ ${s.errors} blocking error — exclude it or fix the source`) : green("  ✓ no blockers")),
  ];
  return lines.join("\n");
};

const renderTuiConfirm = () => {
  const included = ACTIONS.filter((_, i) => !tuiState.excluded.has(i));
  const s = summarize(included);
  return [
    ` ${bold("CONFIRM RUN")} — ${PAIR.name} ${cyan(PAIR.mode)}`,
    "",
    `   ${green(`${s.copies} copy`)} (${fmtBytes(s.copyBytes)}) · ${yellow(`${s.updates} update`)} · ${red(`${s.deletes} delete`)}`,
    `   ${dim(`SafetyNet first: ${s.safetyNetObjects} objects (${fmtBytes(s.safetyNetBytes)}) → _SafetyNet/${RUN_TS}/`)}`,
    `   ${dim(`${tuiState.excluded.size} rows excluded this run (exclusions are per-run, not saved)`)}`,
    "",
    `   ${bold("This is the review-first gate")} — the TUI never runs without landing here.`,
    `   ${dim("CLI equivalent:  vfs run projects-t7          → prints plan, asks y/N")}`,
    `   ${dim("                 vfs run projects-t7 --yes    → executes immediately (agents/cron)")}`,
    "",
    `   ${bold("[y]")} run   ${bold("[esc]")} back to review`,
  ].join("\n");
};

const renderTuiDone = () => {
  const s = summarize(ACTIONS.filter((_, i) => !tuiState.excluded.has(i)));
  return [
    ` ${bold(green("RUN COMPLETE"))} ${dim("(pretend — nothing was executed)")}`,
    "",
    `   ${green(`${s.copies} copied`)} · ${yellow(`${s.updates} updated`)} · ${red(`${s.deletes} deleted`)} · SafetyNet run folder: _SafetyNet/${RUN_TS}/`,
    "",
    `   ${dim("[esc] back to review")}`,
  ].join("\n");
};

const renderTui = () =>
  tuiState.screen === "review" ? renderTuiReview()
  : tuiState.screen === "confirm" ? renderTuiConfirm()
  : renderTuiDone();

// ---------- app shell ----------------------------------------------------------

const state = { tab: 0, cliVariant: 0, jsonVariant: 0 };
const TABS = ["1:CLI human", "2:CLI --json", "3:TUI review"];
const CLI_VARIANTS = ["A — flat ledger", "B — grouped by operation", "C — tree"];

const render = () => {
  const tabBar = TABS.map((t, i) => (i === state.tab ? inv(` ${t} `) : dim(` ${t} `))).join(" ");
  let body, hints;
  if (state.tab === 0) {
    body = [bold(`Variant ${CLI_VARIANTS[state.cliVariant]}`) + dim("  (vfs plan projects-t7)"), "", [renderCliA, renderCliB, renderCliC][state.cliVariant]()].join("\n");
    hints = `${bold("a/b/c")} ${dim("or")} ${bold("←/→")} ${dim("switch variant")}   ${bold("1/2/3")} ${dim("switch tab")}   ${bold("q")} ${dim("quit")}`;
  } else if (state.tab === 1) {
    body = [renderJson1, renderJson2][state.jsonVariant]();
    hints = `${bold("←/→")} ${dim("switch J1/J2")}   ${bold("1/2/3")} ${dim("switch tab")}   ${bold("q")} ${dim("quit")}`;
  } else {
    body = renderTui();
    hints = tuiState.screen === "review"
      ? `${bold("↑/↓")} ${dim("move")}   ${bold("space")} ${dim("include/exclude")}   ${bold("v")} ${dim("layout")}   ${bold("enter")} ${dim("run (review-first)")}   ${bold("1/2/3")} ${dim("tab")}   ${bold("q")} ${dim("quit")}`
      : `${bold("y")} ${dim("confirm")}   ${bold("esc")} ${dim("back")}   ${bold("q")} ${dim("quit")}`;
  }
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(
    [dim("PROTOTYPE — dry-run diff & review (ticket #6). Throwaway."), tabBar, "", body, "", hints, ""].join("\n")
  );
};

const onKey = (key) => {
  if (key === "q" || key === "\x03") { process.stdout.write("\x1b[2J\x1b[H"); process.exit(0); }
  if (key === "1") state.tab = 0;
  else if (key === "2") state.tab = 1;
  else if (key === "3") state.tab = 2;
  else if (state.tab === 0) {
    if (key === "a") state.cliVariant = 0;
    if (key === "b") state.cliVariant = 1;
    if (key === "c") state.cliVariant = 2;
    if (key === "\x1b[C") state.cliVariant = (state.cliVariant + 1) % 3;
    if (key === "\x1b[D") state.cliVariant = (state.cliVariant + 2) % 3;
  } else if (state.tab === 1) {
    if (key === "\x1b[C" || key === "\x1b[D") state.jsonVariant = 1 - state.jsonVariant;
  } else if (state.tab === 2) {
    if (tuiState.screen === "review") {
      if (key === "\x1b[A") tuiState.cursor = Math.max(0, tuiState.cursor - 1);
      if (key === "\x1b[B") tuiState.cursor = Math.min(ACTIONS.length - 1, tuiState.cursor + 1);
      if (key === " ") tuiState.excluded.has(tuiState.cursor) ? tuiState.excluded.delete(tuiState.cursor) : tuiState.excluded.add(tuiState.cursor);
      if (key === "v") tuiState.variant = 1 - tuiState.variant;
      if (key === "\r") {
        const blocked = ACTIONS.some((a, i) => a.op === "error" && !tuiState.excluded.has(i));
        if (!blocked) tuiState.screen = "confirm";
        // blocked: stay — the "Will run" line already shows the blocking error
      }
    } else if (tuiState.screen === "confirm") {
      if (key === "y") tuiState.screen = "done";
      if (key === "\x1b") tuiState.screen = "review";
    } else if (tuiState.screen === "done") {
      if (key === "\x1b") tuiState.screen = "review";
    }
  }
  render();
};

if (!process.stdin.isTTY) {
  // smoke-test mode: PROTO_TAB=1..3 PROTO_VARIANT=0.. PROTO_SCREEN=review|confirm|done
  if (process.env.PROTO_TAB) state.tab = Number(process.env.PROTO_TAB) - 1;
  if (process.env.PROTO_VARIANT) { state.cliVariant = state.jsonVariant = tuiState.variant = Number(process.env.PROTO_VARIANT); }
  if (process.env.PROTO_SCREEN) tuiState.screen = process.env.PROTO_SCREEN;
  render();
  process.exit(0);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", onKey);
render();
