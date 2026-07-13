#!/usr/bin/env node
// ============================================================================
// PROTOTYPE — THROWAWAY. Do not ship. Wayfinder ticket #12.
//
// Question: What does the `vibesync` startup banner look like (flashy ASCII/
// ANSI VIBESYNC logo), and exactly when does it render? Constraints from
// ADR-0004: never pollute machine consumers (--json, piped stdout).
//
// Run: npm run proto:banner    (or: node prototype-cli-banner.mjs)
//
// Tabs:  [1] banner variants B1 / B2 / B3 / B4 (←/→) — press x for shimmer
//        [2] trigger surface — where the banner shows and where it never may
// ============================================================================

const ESC = "\x1b[";
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const inv = (s) => `${ESC}7m${s}${ESC}0m`;
const green = (s) => `${ESC}32m${s}${ESC}0m`;
const red = (s) => `${ESC}31m${s}${ESC}0m`;

// ---------- ANSI Shadow font (only the letters VIBESYNC needs) ----------------

const FONT = {
  V: ["██╗   ██╗", "██║   ██║", "██║   ██║", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚═══╝  "],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  Y: ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
};

const wordRows = (word) => {
  const rows = ["", "", "", "", "", ""];
  for (const ch of word) FONT[ch].forEach((r, i) => (rows[i] += r + " "));
  return rows;
};

// ---------- vaporwave gradient (cyan → purple → pink), truecolor ---------------

const STOPS = [[34, 211, 238], [168, 85, 247], [236, 72, 153]];
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const gradColor = (t) => {
  t = ((t % 1) + 1) % 1;
  const seg = t < 0.5 ? 0 : 1;
  const lt = (t - seg * 0.5) * 2;
  const [a, b] = [STOPS[seg], STOPS[seg + 1]];
  return [lerp(a[0], b[0], lt), lerp(a[1], b[1], lt), lerp(a[2], b[2], lt)];
};
const gradient = (line, phase, width) =>
  [...line]
    .map((ch, x) => {
      if (ch === " ") return ch;
      const [r, g, b] = gradColor(x / (width || line.length) + phase);
      return `${ESC}38;2;${r};${g};${b}m${ch}`;
    })
    .join("") + `${ESC}0m`;

const TAGLINE = "one-way file sync with SafetyNet · plan → review → run";

// ---------- Tab 1: banner variants ----------------------------------------------

const bannerB1 = (phase) => {
  const rows = wordRows("VIBESYNC");
  const w = rows[0].length;
  return [
    bold("B1 — full ANSI-shadow logo, vaporwave gradient"),
    "",
    ...rows.map((r, i) => "  " + gradient(r, phase + i * 0.03, w)),
    "",
    "  " + dim(TAGLINE),
    "  " + dim("v1.0.0 · macOS/Apple Silicon"),
  ].join("\n");
};

const bannerB2 = (phase) => {
  const name = "vibesync";
  return [
    bold("B2 — compact one-liner (banner for people who hate banners)"),
    "",
    "  " + gradient("◆", phase) + " " + bold(gradient(name, phase, 24)) +
      dim(" 1.0.0 · one-way sync with SafetyNet"),
    "",
    dim("  One line above the help text. Never taller. The anti-flashy option —"),
    dim("  included so the flashy ones have to earn their height."),
  ].join("\n");
};

const bannerB3 = (phase) => {
  const letters = "V I B E S Y N C";
  const inner = 34;
  return [
    bold("B3 — boxed retro terminal splash"),
    "",
    "  " + dim("╭" + "─".repeat(inner) + "╮"),
    "  " + dim("│") + "  " + gradient(letters, phase, inner) + " ".repeat(inner - letters.length - 2) + dim("│"),
    "  " + dim("│") + dim("  ~ files in sync · vibes intact ~") + " ".repeat(inner - 34) + dim("│"),
    "  " + dim("│") + dim("  v1.0.0") + " ".repeat(inner - 8) + dim("│"),
    "  " + dim("╰" + "─".repeat(inner) + "╯"),
  ].join("\n");
};

const bannerB4 = (phase) => {
  return [
    bold("B4 — mark + wordmark (modern, small)"),
    "",
    "  " + gradient("◢█◣", phase) + "  " + bold("V I B E S Y N C"),
    "  " + gradient("◥█◤", phase + 0.15) + "  " + dim(TAGLINE),
    "",
    dim("  Three lines. The mark doubles as a favicon/app-icon shape later."),
  ].join("\n");
};

// ---------- Tab 2: trigger surface ------------------------------------------------

const triggers = () => `
${bold("Where the banner renders — proposal baked into this prototype")}

  ${green("$ vibesync")}                       ${green("banner")} + short help ${dim("(no args, TTY)")}
  ${green("$ vibesync --help")}                ${green("banner")} + full help
  ${green("$ vibesync tui")}                   ${green("banner")} as TUI splash, then the review screen

  ${red("$ vibesync plan projects-t7")}      ${red("no banner")} — command output starts at line 1
  ${red("$ vibesync run p --yes --json")}    ${red("no banner")} — --json implies machine consumer
  ${red("$ vibesync --help | less")}         ${red("no banner")} — stdout is not a TTY
  ${red("$ NO_COLOR=1 vibesync")}            plain-text one-liner, no ANSI ${dim("(NO_COLOR respected)")}

${bold("Rules")}
  1. Banner only on the ${bold("no-command surfaces")}: bare invocation, --help, tui startup.
     Working verbs (plan/run/status/history/prune/pair) never print it — their
     first output line is always content (ADR-0003/0004 contracts untouched).
  2. Banner goes to ${bold("stderr")}, and only when stderr is a TTY — it can never
     corrupt parseable stdout even if rule 1 is misapplied.
  3. ${bold("NO_COLOR")} (and a ${bold("VIBESYNC_NO_BANNER=1")} escape hatch) drop to plain text /
     nothing. No --quiet flag needed in v1 — the TTY check covers scripts.
  4. Shimmer animation (x in this prototype): ${bold("static by default")} in the real
     binary; if kept at all, one gradient sweep ≤400 ms on tui startup only.`;

// ---------- app shell ---------------------------------------------------------------

const state = { tab: 0, v: 0, phase: 0, anim: false };
let timer = null;
const VARIANTS = [bannerB1, bannerB2, bannerB3, bannerB4];

const render = () => {
  const tabBar = ["1:banner variants", "2:trigger surface"]
    .map((t, i) => (i === state.tab ? inv(` ${t} `) : dim(` ${t} `)))
    .join(" ");
  const body = state.tab === 0 ? VARIANTS[state.v](state.phase) : triggers();
  const hints =
    state.tab === 0
      ? `${bold("←/→")} ${dim("switch B1–B4")}   ${bold("x")} ${dim(state.anim ? "stop shimmer" : "shimmer!")}   ${bold("1/2")} ${dim("tab")}   ${bold("q")} ${dim("quit")}`
      : `${bold("1/2")} ${dim("switch tab")}   ${bold("q")} ${dim("quit")}`;
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(
    [dim("PROTOTYPE — CLI banner (ticket #12). Throwaway."), tabBar, "", body, "", hints, ""].join("\n")
  );
};

const setAnim = (on) => {
  state.anim = on;
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(() => { state.phase += 0.025; render(); }, 80);
};

const onKey = (key) => {
  if (key === "q" || key === "\x03") { setAnim(false); process.stdout.write("\x1b[2J\x1b[H"); process.exit(0); }
  if (key === "1") state.tab = 0;
  if (key === "2") state.tab = 1;
  if (state.tab === 0) {
    if (key === "\x1b[C") state.v = (state.v + 1) % VARIANTS.length;
    if (key === "\x1b[D") state.v = (state.v + VARIANTS.length - 1) % VARIANTS.length;
    if (key === "x") setAnim(!state.anim);
  }
  render();
};

if (!process.stdin.isTTY) {
  // smoke-test mode: PROTO_TAB=1..2 PROTO_VARIANT=0..3
  if (process.env.PROTO_TAB) state.tab = Number(process.env.PROTO_TAB) - 1;
  if (process.env.PROTO_VARIANT) state.v = Number(process.env.PROTO_VARIANT);
  render();
  process.exit(0);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", onKey);
render();
