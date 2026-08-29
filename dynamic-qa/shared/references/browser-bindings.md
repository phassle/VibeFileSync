# Browser Binding conventions (`qa-generate` generation step 2, browser level)

Shared reference for `qa-generate`'s generation workflow, built into both
skills by `dynamic-qa/build.sh` from this single source
(`dynamic-qa/shared/references/`) — see `dynamic-qa/DECISIONS.md` §18. It
covers the part of step 2 ("author the smallest new Binding file that fits
the existing layout's conventions") that is specific to a **browser**
Binding: which selectors a generated or repaired browser test may target,
when — and only when — a new dedicated test hook may be proposed, and how
browser waits must be expressed. This does not replace step 2's existing
prose; it is the browser-specific addendum SPEC-135 user stories 33-36
require, backed by `shared/scripts/browser-conventions.mjs` (selector/hook
rules) and `shared/scripts/forbidden-patterns.mjs` (fixed-sleep detection,
extended by this ticket with browser-specific idioms — see below).

A generated browser Binding must survive a harmless refactor: a rename of a
CSS class, a rebuild that reshuffles hashed class names, a reordered list,
a framework upgrade that changes its internal DOM attributes. None of those
change the product's behavior, so none of them may break a generated test.
Selector choice is therefore not free-form model judgment — every candidate
selector is checked by `validateSelector` before a Binding is accepted, the
same way #146's forbidden-pattern scan checks for fixed sleeps and stub
tests.

## Reuse the customer's existing convention — never impose a new one

Before authoring any selector, call `detectHookConvention(files)` against
the repository's existing source (components, templates, existing browser
tests). A repository that already has a deliberate stable test-hook
attribute — `data-cy`, `data-testid`, `data-qa`, `data-automation-id`, or
any other consistent `data-*` hook — gets that exact attribute name back.
Generation never renames it to whatever this bundle happens to prefer, and
never introduces a second, competing convention alongside it.

- `{ detected: true, attribute, occurrences, candidates }` — follow
  `attribute` for every new selector this generation writes.
- `{ detected: false, ambiguous: false }` — no convention exists yet in this
  repository. New hooks (see below) fall back to `data-testid`.
- `{ detected: false, ambiguous: true, candidates }` — two or more hook
  attributes are in real use with no clear majority. Do not guess: report
  this in the review packet as a question for the Technical Owner rather
  than silently picking one.

## Propose a new hook only for a critical or ambiguous point

Call `proposeHook(point, conventionResult)` for an interaction point that
has no selector yet. It proposes a hook **only** when the point is critical
or ambiguous *and* has no stable selector already — never for an ordinary
element that already has a workable, stable target. This keeps the product
free of blanket test attributes: most of the page is not touched.

When it does propose one, it follows the detected convention's attribute
name (`conventionResult.attribute`) rather than forcing `data-testid` —
`data-testid` is used only when `detectHookConvention` found nothing to
follow. Every proposal states its reason (`critical` or `ambiguous`, plus
the point's description) so the review packet can show a human exactly why
this one point earned a new hook and the rest did not. A missing hook a
generation declines to add is a tracked product change to raise with the
Technical Owner, never a hook manufactured wholesale to avoid raising it.

## Forbidden selectors, always

`validateSelector(selector, { hookAttribute })` rejects five selector
classes outright, each with its own named error code so a review packet can
say exactly why a candidate was refused:

| Class | Error code | Why |
| --- | --- | --- |
| Generated/runtime-assigned element IDs (`#ember482`, `#react-select-2-input`, `#mui-12`, React's `useId` `:r3:` form) | `generated-id-selector` | Not stable across a rebuild or a re-render. |
| Hashed build-tool class names (CSS Modules, styled-components `.sc-...`, emotion `.css-...`) | `hashed-class-selector` | The hash changes on a harmless rebuild. |
| Transient framework-internal attributes (Vue's `data-v-...`, Angular's `ng-reflect-...`, `data-reactid`, `data-emotion`, raw `style`) | `transient-attribute-selector` | Implementation detail, not a contract with the user. |
| DOM-position selectors (`:nth-child()`, `:nth-of-type()`, `.eq(n)`, `.nth(n)`, `:first-child`/`:last-child` used positionally) | `dom-position-selector` | Sibling order is not a stable contract. |
| XPath expressions | `xpath-selector` | Encodes DOM structure, not intent. |

A candidate Binding that targets any of these is refused, the same way a
forbidden pattern refuses an otherwise-plausible file in #146.

## Stable role/accessibility contracts are always valid targets

A selector built on a stable role/accessible-name contract —
`getByRole(...)`, `getByLabel(...)`, `[role=...]`, `[aria-label=...]`,
`[aria-labelledby=...]` — is always accepted (`kind: "role-or-accessibility"`
from `validateSelector`). This is a product contract with the user, not an
implementation detail, so it is preferred wherever the interaction point
already has one, ahead of proposing a new dedicated hook.

## Waits bind to bounded readiness signals, never fixed sleeps

Fixed sleeps are already forbidden across every framework by
`forbidden-patterns.mjs`'s `detectFixedSleep` (#146) — this ticket does not
duplicate that detector. It extends it with three browser-specific idioms
the original pattern set did not name: Selenium's `driver.sleep(...)`,
WebdriverIO's `browser.pause(...)`, and legacy Puppeteer's `.waitFor(ms)`
(distinct from — and never confused with — Playwright's
`waitForTimeout(...)`, already forbidden). A generated or repaired browser
check waits on a bounded, concrete readiness signal instead — an element
becoming visible/enabled, a specific text appearing, a network request
resolving by name — never on an arbitrary elapsed duration or
`networkidle`.
