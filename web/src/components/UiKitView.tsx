import { Archive, Check, Copy, Plus, RefreshCw, Save, Settings2, Sparkles, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardGrid,
  CardHeader,
  Checkbox,
  DetailList,
  Dialog,
  DialogBody,
  DialogFooter,
  Disclosure,
  EmptyState,
  Field,
  FieldRow,
  FormStack,
  IconButton,
  Menu,
  Page,
  Popover,
  SearchInput,
  Spinner,
  Tabs,
  Tag,
  TagList,
  Tooltip,
  useToast,
} from "../ui";

/**
 * Every kit component in its states, on one page: the place to check a change to the design system
 * in both themes before it lands on real screens. Reachable at ?view=ui-kit; deliberately not in the
 * sidebar.
 */
export function UiKitView() {
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [checked, setChecked] = useState(true);
  const [search, setSearch] = useState("");

  return (
    <Page title="UI kit" tip="Every component in web/src/ui, in its states. See docs/DESIGN-SYSTEM.md for when to use which." narrow>
      <Section title="Buttons">
        <Row>
          <Button variant="primary" icon={Save}>
            Primary
          </Button>
          <Button icon={Plus}>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={Trash2}>
            Danger
          </Button>
          <Button variant="link">Link</Button>
        </Row>
        <Row>
          <Button variant="primary" size="sm" icon={Check}>
            Small primary
          </Button>
          <Button size="sm">Small</Button>
          <Button variant="primary" loading loadingText="Saving…">
            Save
          </Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <IconButton label="Settings" icon={Settings2} />
          <IconButton label="Copy" icon={Copy} size="sm" />
          <IconButton label="Delete" icon={Trash2} variant="danger" />
          <IconButton label="Archive" icon={Archive} disabled disabledReason="Shown on hover to say why it's off" />
          <Spinner />
        </Row>
      </Section>

      <Section title="Badges and tags">
        <Row>
          <Badge tone="success">Ready</Badge>
          <Badge tone="warn">Needs you</Badge>
          <Badge tone="danger">Failed</Badge>
          <Badge tone="info">Resets 2:40 PM</Badge>
          <Badge tone="accent" icon={Sparkles}>
            Running
          </Badge>
          <Badge>Idle</Badge>
        </Row>
        <TagList>
          <Tag>neutral</Tag>
          <Tag tone="accent">accent</Tag>
          <Tag tone="success" icon={Check}>
            success
          </Tag>
          <Tag tone="warn">warn</Tag>
          <Tag href="https://example.com">a link</Tag>
        </TagList>
      </Section>

      <Section title="Callouts">
        <Callout tone="info">Something worth knowing before you go on.</Callout>
        <Callout tone="success">Replied “ok” in 2.1s.</Callout>
        <Callout tone="warn">Actions still running in Review will be cancelled.</Callout>
        <Callout tone="danger">Could not reach the server.</Callout>
      </Section>

      <Section title="Forms">
        <Card>
          <FormStack>
            <FieldRow>
              <Field label="Name" grow>
                <input placeholder="Required by default" />
              </Field>
              <Field label="Limit" optional tip="Detail that helps but isn't needed up front goes here.">
                <input type="number" placeholder="None" />
              </Field>
            </FieldRow>
            <Field label="Description" optional>
              <textarea rows={3} placeholder="Markdown supported" />
            </Field>
            <Field label="Branch" error="No such branch in this repository.">
              <select aria-invalid defaultValue="x">
                <option value="x">feature/missing</option>
              </select>
            </Field>
            <Field label="Clone" note="A line that must be read before submitting, like a clone copying credentials.">
              <input defaultValue="Team copy" />
            </Field>
            <Checkbox checked={checked} onChange={setChecked} label="Wait for my approval" tip="Tips work on checkboxes too." />
            <SearchInput value={search} onChange={setSearch} label="Search" placeholder="Search…" />
            <Disclosure summary="Advanced">
              <Field label="Key">
                <input className="mono" defaultValue="implement" />
              </Field>
            </Disclosure>
          </FormStack>
        </Card>
      </Section>

      <Section title="Overlays">
        <Row>
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <Menu
            label="Example menu"
            align="start"
            trigger={<Button>Open menu</Button>}
            items={[
              { key: "a", label: "Duplicate", icon: Copy, onSelect: () => toast("Duplicated") },
              { key: "b", label: "With a hint", hint: "A quieter second line", onSelect: () => undefined },
              { key: "c", label: "Current choice", active: true, onSelect: () => undefined },
              { key: "d", label: "Delete", icon: Trash2, divided: true, danger: true, onSelect: () => toast("Deleted", "error") },
            ]}
          />
          <Popover label="Example popover" trigger={<Button>Open popover</Button>} width={260}>
            <p className="muted small">Any content: a list, a picker.</p>
          </Popover>
          <Tooltip content="A short label">
            <Button variant="ghost">Hover for a tooltip</Button>
          </Tooltip>
          <Button icon={RefreshCw} onClick={() => toast("Saved “Feature”")}>
            Toast
          </Button>
          <Button variant="danger" onClick={() => toast("Could not save", "error")}>
            Error toast
          </Button>
        </Row>
      </Section>

      <Section title="Cards and content">
        <CardGrid>
          <Card>
            <CardHeader icon={<Sparkles size={20} />} title="Card title" tip="A tip on a heading." aside={<Badge tone="success">Ready</Badge>} />
            <DetailList
              items={[
                ["Version", "2.1.267"],
                ["Path", <span className="mono">C:\tools\claude.exe</span>],
                ["Missing", null],
              ]}
            />
          </Card>
          <Card>
            <Tabs
              label="Example"
              tabs={[
                { value: "one", label: "Activity", content: <p className="muted">First panel.</p> },
                { value: "two", label: "Details", content: <p className="muted">Second panel.</p>, keepMounted: true },
              ]}
            />
          </Card>
        </CardGrid>
        <EmptyState icon={Archive} title="Nothing here yet" action={<Button icon={Plus}>Add the first one</Button>}>
          One sentence on what will appear here.
        </EmptyState>
      </Section>

      {dialog && (
        <Dialog title="Example dialog" onClose={() => setDialog(false)} onSubmit={() => setDialog(false)}>
          <DialogBody lead="The thing it acts on">
            <ul>
              <li>A consequence worth reading first.</li>
            </ul>
            <Field label="A field">
              <input autoFocus />
            </Field>
          </DialogBody>
          <DialogFooter onCancel={() => setDialog(false)} start={<Button variant="danger">Delete</Button>}>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </Page>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="kit-section">
      <h2 className="kit-section__title">{title}</h2>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="kit-row">{children}</div>;
}
