# Agentify — Design system

The UI is built from one small kit, `web/src/ui`, on top of one set of tokens, `web/src/ui/tokens.css`.
Screens compose kit components; they don't style controls of their own. This page says what's in the
kit, which piece to reach for, and the rules that keep screens consistent.

See every component in every state at **`?view=ui-kit`** (reachable by URL only, not in the sidebar).
Check a kit change there in both themes before it lands on real screens.

## Principles

1. **Self-explanatory, and quiet.** Labels and good defaults carry the meaning. No page subtitles, no
   grey paragraph under every field. Detail that helps but isn't needed up front goes in an `InfoTip`
   (the ⓘ beside a label). Inline text is only for errors, live data ("In order: A → B"), and a
   consequence worth reading before you confirm (a workspace clone copies credentials).
2. **One way to do each thing.** A button is a `Button`; a status is a `Badge`; a dialog is a
   `Dialog`. If a screen needs something the kit doesn't have, add it to the kit.
3. **Sensible defaults.** `Button` is `type="button"`, so it never submits a form by accident.
   `Dialog` focuses the first field, or else the main button, never the ✕. `Field` is required unless
   marked `optional`. `Tabs` start on the first tab.
4. **Say why, not just no.** A disabled `IconButton` takes a `disabledReason` that shows as its
   tooltip. A button that works on saved data says so in its `title`.
5. **Rare settings fold away.** Put them in a `Disclosure` ("Advanced"), which opens by itself when
   something in it isn't at its default or has an error. An action marks such fields `advanced: true`
   in its server-side field list, and the editor folds them without knowing their names.

## Tokens

All raw values live in `tokens.css`, each colour with a light and a dark value.

| Scale | Tokens | Values |
| --- | --- | --- |
| Text | `--text-xs` `-sm` `-md` `-base` `-lg` `-xl` | 11 · 12 · 13 · 14 · 16 · 22px |
| Spacing | `--space-1` … `--space-8` | 4 · 8 · 12 · 16 · 20 · 24 · 32px |
| Corners | `--radius-sm` `--radius` `--radius-lg` `--radius-full` | 6 · 8 · 12px · round |
| Controls | `--control-sm` `--control-md` | 26 · 32px tall |
| Elevation | `--shadow-sm` `-md` `-lg` | resting card · floating menu · dialog |

Colours: surfaces `--bg`, `--surface`, `--surface-2`, `--surface-3`; text `--text`, `--text-2`,
`--text-3`; lines `--border`, `--border-strong`; `--accent` (+ `-soft`, `-text`) and `--primary` for
filled accent surfaces (the same deep teal in both themes, so white text on it reads); status
`--success`, `--warn`, `--danger`, `--info`, each with a `-soft` background; `--log-*` for terminal
output, which stays dark in both themes. Brand marks colour themselves through `[data-brand]`.

**Tones.** `Badge`, `Tag` and `Callout` take a `tone`: `neutral`, `accent`, `success`, `warn`,
`danger`, `info`. Use them for meaning, not decoration: `success` done, `warn` needs you, `danger`
failed or destructive, `info` waiting on something outside, `accent` in progress or highlighted.

## Components

Import everything from `web/src/ui` (`import { Button, Field } from "../ui"`).

| Need | Use | Notes |
| --- | --- | --- |
| An action | `Button` | `variant`: `primary` (the one main action in view), `secondary` (default), `ghost`, `danger`, `link` (inline in text). `size`: `md`, `sm`. `icon`, and `loading` + `loadingText` ("Saving…"). |
| An icon-only action | `IconButton` | `label` is required: it is the accessible name *and* the tooltip. `disabledReason` for why it's off. |
| A form field | `Field` | Wraps one native `input`/`select`/`textarea`. `optional`, `tip`, `error`, `note` (rare), `grow` in a row. `group` for several controls (it becomes a `fieldset`). |
| Fields side by side | `FieldRow` | Stacks below 720px. |
| A form's body | `FormStack` | The standard vertical gap. |
| A checkbox | `Checkbox` | `onChange` gets the boolean. Takes a `tip`. |
| A search box | `SearchInput` | |
| Extra detail | `InfoTip` | Hover, focus or tap. Put it through `Field`'s or `Page`'s `tip`. |
| A short label on hover | `Tooltip` | Passes props through, so it can be a `Menu`/`Popover` trigger. |
| Rarely changed settings | `Disclosure` | Native `<details>`. `defaultOpen` when something inside needs attention. |
| A modal | `Dialog` + `DialogBody` + `DialogFooter` | Open while mounted; `onClose` for Escape, backdrop and ✕. `onSubmit` makes it a form. `DialogBody lead` names what it acts on; a plain `<ul>` inside lists consequences. `DialogFooter`: `start` (a destructive extra), `onCancel`, `cancelLabel` (when the main action is itself a cancel), `busy`. `bare` for custom layouts (the agent chat). |
| A list of actions | `Menu` | `trigger` is a kit button. Items: `label`, `icon`, `hint`, `active` (ticked), `divided`, `danger`. |
| A floating panel | `Popover` | For pickers and lists that aren't actions. |
| Views of one thing | `Tabs` | `keepMounted` keeps a form's edits while you look at another tab. |
| A status | `Badge` | Bold, filled, with a dot or icon. |
| A label | `Tag`, `TagList` | Quiet; `href` makes it a link. |
| A message | `Callout` | The result of something you did, or a warning. `danger` is announced. |
| Read-only facts | `DetailList` | Label/value rows; missing values show "—". |
| A settings panel | `Card`, `CardHeader`, `CardGrid` | `CardHeader brand` tints the icon tile. |
| A page | `Page` | `title`, `tip`, `actions`, `narrow` for settings pages. |
| Nothing here yet | `EmptyState` | Icon, title, one sentence, and the way to add the first thing. |
| Loading or failed, whole screen | `Splash` | |
| Busy | `Spinner` | |
| Feedback after an action | `useToast()` | `toast("Saved “Feature”")`, `toast(message, "error")`. |

Interactive pieces (Dialog, Menu, Popover, Tooltip, Tabs) are built on
[Radix Primitives](https://www.radix-ui.com/primitives): keyboard handling, focus trapping, stacking
and placement come from there. Only `web/src/ui` imports `radix-ui`. When a Radix layer handles
Escape it marks the event handled (`defaultPrevented`), so page-level Escape handlers (the task drawer,
the mobile sidebar) check that and stand aside.

Native `<select>` is used for choices on purpose: it's light and the platform picker is better on
phones.

## Writing UI

- Title case for page titles only; everything else is sentence case. Buttons say what they do
  ("Delete workflow", not "OK"), and while working, what they're doing ("Deleting…").
- A destructive dialog names the thing (`lead`), lists what goes, and uses a `danger` button.
- Icons come from lucide (`lucide-react`). Check the icon's page on lucide.dev before picking it.
- Page-specific layout (the board, the drawer, the chat) lives in `web/src/styles.css`, and uses the
  tokens like everything else. Visual styling of controls belongs in the kit.

## Enforced by a test

`web/src/ui/design-system.test.ts` fails when:

- a screen writes a class the kit owns or replaced (`button`, `chip`, `field`, `hint`, `modal-*`, …)
  or reaches into the kit's own `ui-*` classes;
- anything outside `web/src/ui` imports `radix-ui`;
- a stylesheet other than `tokens.css` has a hex colour, a font size in px, or a single-value
  corner radius in px;
- a padding, margin or gap is off the grid: even pixels only, and multiples of 4 from 16px up
  (0–2px hairlines excepted).
