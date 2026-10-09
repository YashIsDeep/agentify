import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DeviceInfo,
  formatPairingCode,
  pairingLink,
  type RemoteAccessStatus,
  type RemoteAddressKind,
} from "@wm/shared";
import { Copy, Laptop, LogOut, MonitorSmartphone, QrCode as QrCodeIcon, Smartphone, Trash2, Wifi } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ACCESS_LOST_EVENT, serverApi, sessionApi } from "../api";
import { relativeTime } from "../lib/format";
import { useSession } from "../session-context";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  DetailList,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  IconButton,
  InfoTip,
  Page,
  Spinner,
  Tag,
  useToast,
} from "../ui";
import { QrCode } from "./QrCode";

const ADDRESS_LABELS: Record<RemoteAddressKind, string> = {
  "tailscale-https": "Tailscale (https)",
  lan: "Local network",
  tailscale: "Tailscale",
};

export const REMOTE_ACCESS_QUERY = ["remote-access"] as const;

/** Using Agentify from a phone or another computer: the switch, pairing, and the paired devices. */
export function DevicesView() {
  const session = useSession();
  const status = useQuery({ queryKey: REMOTE_ACCESS_QUERY, queryFn: serverApi.remoteAccess });
  return (
    <Page title="Devices" narrow>
      {status.error && <Callout tone="danger">{status.error.message}</Callout>}
      {status.data && session.access === "host" && <RemoteAccessCard status={status.data} />}
      {status.data && <PairedDevicesCard status={status.data} />}
    </Page>
  );
}

function RemoteAccessCard({ status }: { status: RemoteAccessStatus }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);
  const toggle = useMutation({
    mutationFn: serverApi.setRemoteAccess,
    onSuccess: (next) => queryClient.setQueryData(REMOTE_ACCESS_QUERY, next),
    onError: (error) => toast(error.message, "error"),
  });

  return (
    <Card>
      <CardHeader
        icon={<Wifi size={20} />}
        title="Remote access"
        tip="Lets your phone or another computer use Agentify from your Wi-Fi or tailnet. Each device pairs once with a code from this computer. Connections from the internet are refused, even through a tunnel."
        aside={<Badge tone={status.enabled ? "success" : "neutral"}>{status.enabled ? "On" : "Off"}</Badge>}
      />
      {status.listenError && <Callout tone="danger">{status.listenError}</Callout>}
      {status.enabled && (status.addresses.length > 0 || status.tailscaleServeCommand ? (
        <DetailList items={addressRows(status)} />
      ) : (
        <Callout tone="warn">This computer has no address another device could reach. Connect it to Wi-Fi or Tailscale.</Callout>
      ))}
      <div className="devices-actions">
        {status.enabled ? (
          <>
            <Button
              variant="primary"
              icon={QrCodeIcon}
              disabled={status.addresses.length === 0}
              title={status.addresses.length === 0 ? "No address to connect to" : undefined}
              onClick={() => setConnecting(true)}
            >
              Connect a device
            </Button>
            <Button loading={toggle.isPending} loadingText="Turning off…" onClick={() => toggle.mutate(false)}>
              Turn off
            </Button>
          </>
        ) : (
          <Button variant="primary" loading={toggle.isPending} loadingText="Turning on…" onClick={() => toggle.mutate(true)}>
            Turn on remote access
          </Button>
        )}
      </div>
      {connecting && <PairDialog status={status} onClose={() => setConnecting(false)} />}
    </Card>
  );
}

/** One row per kind of address; a computer on Ethernet and Wi-Fi has two local ones. */
function addressRows(status: RemoteAccessStatus): [string, ReactNode][] {
  const rows = new Map<RemoteAddressKind, string[]>();
  for (const { kind, url } of status.addresses) rows.set(kind, [...(rows.get(kind) ?? []), url]);
  const items: [string, ReactNode][] = [...rows].map(([kind, urls]) => [
    ADDRESS_LABELS[kind],
    <span className="devices-addresses">
      {urls.map((url) => <CopyableText key={url} text={url} label="Copy address" />)}
    </span>,
  ]);
  if (status.tailscaleServeCommand) {
    items.push([
      ADDRESS_LABELS["tailscale-https"],
      <span className="devices-addresses">
        <span className="devices-command">
          <CopyableText text={status.tailscaleServeCommand} label="Copy command" />
          <InfoTip>Run this once on this computer for an https address that works wherever your phone has Tailscale.</InfoTip>
        </span>
      </span>,
    ]);
  }
  return items;
}

function CopyableText({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  return (
    <span className="devices-copyable">
      <code>{text}</code>
      <IconButton
        label={label}
        icon={Copy}
        size="sm"
        onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Could not copy", "error"))}
      />
    </span>
  );
}

/**
 * A one-use code as a QR code and as text. It closes itself once a device pairs; closing it any other
 * way withdraws the code, so none is left waiting.
 */
function PairDialog({ status, onClose }: { status: RemoteAccessStatus; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [address, setAddress] = useState(status.addresses[0]?.url ?? "");
  const known = useRef(new Set(status.devices.map((device) => device.id)));
  const shown = useRef<string | null>(null);
  const now = useNow();
  const start = useMutation({
    mutationFn: serverApi.startPairing,
    onSuccess: (next) => queryClient.setQueryData(REMOTE_ACCESS_QUERY, next),
  });

  useEffect(() => {
    start.mutate();
    return () => {
      if (shown.current) void serverApi.cancelPairing(shown.current).catch(() => {});
    };
    // A fresh code once, when the dialog opens.
  }, []);

  const pairing = status.pairing;
  useEffect(() => {
    if (pairing) shown.current = pairing.code;
  }, [pairing]);
  const added = status.devices.find((device) => !known.current.has(device.id));
  useEffect(() => {
    if (!added) return;
    shown.current = null;
    toast(`Paired ${added.name}`);
    onClose();
  }, [added, onClose, toast]);

  const remaining = pairing ? pairing.expiresAt - now : 0;
  const usable = pairing !== null && remaining > 0;

  return (
    <Dialog title="Connect a device" onClose={onClose}>
      <DialogBody>
        {start.isPending && !pairing ? (
          <div className="pair-dialog-waiting"><Spinner /></div>
        ) : start.error ? (
          <Callout tone="danger">{start.error.message}</Callout>
        ) : usable ? (
          <div className="pair-dialog">
            <QrCode value={pairingLink(address, pairing.code)} label="QR code that opens Agentify on your device and pairs it" />
            <strong className="pair-dialog-code">{formatPairingCode(pairing.code)}</strong>
            {status.addresses.length > 1 && (
              <div className="pair-dialog-address">
                <Field label="Address">
                  <select value={address} onChange={(event) => setAddress(event.target.value)}>
                    {status.addresses.map(({ kind, url }) => (
                      <option key={url} value={url}>{`${url} (${ADDRESS_LABELS[kind]})`}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <p className="pair-dialog-how">
              Scan it with the device's camera, or open <code>{address}</code> there and enter the code. Expires in {countdown(remaining)}.
            </p>
          </div>
        ) : (
          <Callout tone="warn">This code can't be used any more.</Callout>
        )}
      </DialogBody>
      <DialogFooter>
        {!usable && !start.isPending && (
          <Button onClick={() => start.mutate()}>New code</Button>
        )}
        <Button variant="primary" onClick={onClose}>Done</Button>
      </DialogFooter>
    </Dialog>
  );
}

function PairedDevicesCard({ status }: { status: RemoteAccessStatus }) {
  const session = useSession();
  const ownId = session.access === "device" ? session.device.id : null;
  return (
    <Card>
      <CardHeader
        icon={<MonitorSmartphone size={20} />}
        title="Paired devices"
        tip="A device stays paired until it's removed here, signs itself out, or goes unused for 30 days."
        aside={status.devices.length === 0 ? <span className="muted">none yet</span> : undefined}
      />
      {status.devices.length > 0 && (
        <ul className="device-list">
          {status.devices.map((device) => (
            <DeviceRow key={device.id} device={device} own={device.id === ownId} canRemove={session.access === "host"} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeviceRow({ device, own, canRemove }: { device: DeviceInfo; own: boolean; canRemove: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => serverApi.removeDevice(device.id),
    onSuccess: () => {
      toast(`Removed ${device.name}`);
      void queryClient.invalidateQueries({ queryKey: REMOTE_ACCESS_QUERY });
    },
    onError: (error) => toast(error.message, "error"),
  });
  const signOut = useMutation({
    mutationFn: sessionApi.signOut,
    // The session lives above this workspace: asking it again lands this device on the pairing screen.
    onSuccess: () => window.dispatchEvent(new Event(ACCESS_LOST_EVENT)),
    onError: (error) => toast(error.message, "error"),
  });
  const Icon = /^(iPhone|iPad|Android)\b/.test(device.name) ? Smartphone : Laptop;
  const now = useNow(30_000);

  return (
    <li className="device-row">
      <Icon size={18} className="device-icon" aria-hidden="true" />
      <span className="device-name">
        {device.name}
        {own && <Tag tone="accent">This device</Tag>}
      </span>
      <span className="device-seen muted" title={new Date(device.lastSeenAt).toLocaleString()}>
        {now - device.lastSeenAt < 120_000 ? "Active now" : `Last used ${relativeTime(device.lastSeenAt, now)}`}
      </span>
      {own ? (
        <Button size="sm" icon={LogOut} loading={signOut.isPending} loadingText="Signing out…" onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      ) : canRemove ? (
        <IconButton label={`Remove ${device.name}`} icon={Trash2} variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()} />
      ) : null}
    </li>
  );
}

/** The current time, ticking at `every` ms, for countdowns and "last used" lines. */
function useNow(every = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
