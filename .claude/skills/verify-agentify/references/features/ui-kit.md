# UI kit & themes

The design system's gallery of every `web/src/ui` component in its states, along with the light and dark themes.

## Sub-features

- gallery sections: Buttons, Badges and tags, Callouts, Forms, Overlays, Cards and content.
- themes: light and dark tokens in `web/src/ui/tokens.css`, switched by the sidebar's Theme radios.
- conventions: no subtitles or under-field hints (use an `InfoTip` on the label instead), lucide icons, and one primary action per surface. See `docs/DESIGN-SYSTEM.md`.

## How to get to it (user POV)

It is reachable by URL only: `/?view=ui-kit`. It is deliberately left out of the sidebar.

## Driving it

- `navigate` to `/?view=ui-kit`, then screenshot each section in both themes (click `radio "Dark theme"`).
- `web/src/ui/design-system.test.ts` guards the token and component rules. Run `npm test -w web` after UI-kit changes.

## Gotchas

- New primitives belong in `web/src/ui`, with a section added here, rather than as one-off styles in `styles.css`.
- Use icons from lucide only. Never hand-draw SVGs.
