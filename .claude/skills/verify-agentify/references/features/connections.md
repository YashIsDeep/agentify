# Connections

The **Connections** page stores this workspace's credentials for Jira, Linear and Notion, which integration actions and ticket drafting use.

## Sub-features

- empty: "No connections yet" with **Add Jira**, **Add Linear** and **Add Notion** buttons.
- add dialog: `Add <Type> connection`, with Name and the server-declared fields (Jira: **Site URL**, **Account email**, **API token**; Linear: **API key**; Notion: **Internal integration token**). Secret fields are password inputs. **Where to create this credential ↗** links to the provider's docs, and **Add connection** saves.
- card: name, a type tag, and editable fields. A saved secret shows "•••••••• saved", and an untouched field keeps it. Buttons: **Save**, **Test**, **Delete**.
- missing callout: "Still needs <field> and <field>."
- test: "Authenticated as <who> in 1.2s" or an error. It tests the saved credentials, not the ones being typed.
- delete: a `Delete connection` dialog explains that actions using it will fail, and the credential is removed from `secrets.json`.

## How to get to it (user POV)

Sidebar → **Connections**.

## Driving it

- `navigate` to `/?view=connections`. `find "Add Jira"` opens the dialog.
- API: `GET .../connection-types`, `GET/POST .../connections`, `PUT/DELETE .../connections/<id>`, `POST .../connections/<id>/test`.
- Real tests need real accounts. Without one, verify the form, save and delete paths, and mark Test as unreachable.

## Gotchas

- Secrets are write-only. The API reports only `secretsSet`, never values. An untouched secret field is omitted on save and keeps its saved value. Typing into a secret field and saving it blank sends `""`, which clears the credential.
- Credentials live in `secrets.json` beside the database, never inside it. Duplicating a workflow never carries a token, but cloning a workspace does.
- Notion answers 404 until the page or database is shared with the integration.
- Jira requires HTTPS (a bare hostname defaults to it), and redirects are refused.
