# Agents page

The **Agents** page lets you check which coding-agent CLIs are installed and logged in, and set per-agent defaults, the global concurrency cap and ticket drafting.

## Sub-features

- refresh: **Refresh status** in the page header. Status is cached for 60s.
- agent cards: Claude Code, Codex, OpenCode and Cursor Agent, each with a brand icon and a readiness badge: **Ready**, **Not logged in**, **Login unknown**, **Not installed** or **Not found**.
- defaults: **Default model** (grouped dropdown from the CLI's own list) and **Default effort**, saved with **Save defaults**. The toast reads "<Agent> defaults saved".
- test: **Test agent** sends a short read-only prompt with the saved defaults. The result is "Replied “…” in 1.2s · usage" or an error callout. It is disabled when the CLI isn't installed or is known to be logged out, and the tooltip explains why. It stays enabled under **Login unknown**.
- fix-it hints: **Install** or **Log in from a terminal, then refresh status** with a copyable command (**Copy command**).
- setup disclosure: **Setup** shows Version, Executable and Login detail, plus **Executable override** with **Save path** / **Reset**. It opens automatically when there is an error.
- concurrency: the **Agents at once** card (1–50, "Enter a whole number from 1 to 50"), saved with **Save limit**. Global across workspaces.
- ticket drafting: **Agent** ("None — copy the ticket" or an agent), Model and Effort, saved with **Save settings**. Used by the New task dialog.

## How to get to it (user POV)

Sidebar → **Agents**.

## Driving it

- `navigate` to `/?view=agents`. Agent cards are `section`s labelled with the agent name (`region "Claude Code"`). Use `find "Test agent"` within one.
- API: `GET .../agents`, `GET .../agent-models`, `PUT .../agents/<id> {path}`, `PUT .../agents/<id>/defaults {model, effort}`, `POST .../agents/<id>/test`, `GET/PUT /api/settings/concurrency`, and `GET/PUT .../settings/ticket-draft`.

## Gotchas

- **Test agent** tests the saved defaults, not unsaved dropdown changes. The tooltip says "Save first to test this choice."
- **Test agent** spends a real request on the person's own subscription. Ask before running it.
- The app strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from agent environments, so the agents use their CLI subscription logins.
- Model lists come from `codex debug models`, `opencode models --verbose` and `cursor-agent models`, plus Claude's documented aliases. When discovery isn't available (for example, the CLI isn't installed), the dropdown falls back to built-in model and effort hints (`source: "builtin"`).
