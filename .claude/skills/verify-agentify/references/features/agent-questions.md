# Agent questions

Agents can stop mid-run to ask you something through an MCP tool, and the question appears as a form in the chat.

## Sub-features

- tool: `ask_user` on an MCP server named `workflow` (qualified as `mcp__workflow__ask_user`), served per run at `/mcp/<token>`. It takes `{preamble?, questions[{id?, text, options?, multiline?}]}` and blocks until you answer.
- wiring: Claude Code and Codex get the tool. A Claude run that is given the question endpoint also gets `--strict-mcp-config`, so your own MCP servers don't join. A run without the endpoint gets neither. CI loops don't ask: the check command decides.
- card: "The agent is waiting on you", the preamble, then numbered fields. A choice field has radio options plus "Your own answer, or a note…". A text field is an input, or a textarea when multiline.
- **Let it decide**: skips, and the agent carries on with its own judgement.
- **Use recommended**: shown while choices are unpicked. It picks the first option of each, because agents list their recommendation first.
- **Send answer**: enabled once at least one field is answered. A counter shows "N of M answered".
- badges: the task becomes Needs you with "Question from <agent>". The run row shows a question icon, and the drawer header shows **Answer**.

## How to get to it (user POV)

When a task needs you with a question, click **Answer** in the drawer, or the **Needs you** counter and then the task's entry in Open conversations.

## Driving it

- Card selector: `form.question-card`. Radios use `name="<questionId>-<fieldId>"`.
- API: `GET .../questions` (pending), `POST .../questions/<id>/answer {answers:{fieldId:value}, skip:false}`.
- Forcing a real question needs a real agent run (Claude or Codex) with a prompt that asks one. Mark it unreachable if no CLI is logged in.

## Gotchas

- CLI tool-call timeouts: a live Claude Code run ended the call after about 353s despite the 24h ceiling. The tool description tells the agent to ask again if it times out. See DESIGN.md §3.1.
- The pending question is shown only as the live card and is not repeated as a history bubble.
- Fields you leave unanswered are reported to the agent as unanswered.
