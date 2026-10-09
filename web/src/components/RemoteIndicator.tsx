import { useQuery } from "@tanstack/react-query";
import { MonitorSmartphone } from "lucide-react";
import { serverApi } from "../api";
import { countOf } from "../lib/format";
import { Tooltip } from "../ui";
import { REMOTE_ACCESS_QUERY } from "./DevicesView";

/** Beside Live while remote access is on, so it is never on unnoticed. Opens the Devices page. */
export function RemoteIndicator({ onOpen }: { onOpen: () => void }) {
  const status = useQuery({ queryKey: REMOTE_ACCESS_QUERY, queryFn: serverApi.remoteAccess, staleTime: 60_000 });
  if (!status.data?.enabled) return null;
  const label = `Remote access is on · ${countOf(status.data.devices.length, "paired device")}`;
  return (
    <Tooltip content={label}>
      <button type="button" className="remote-indicator" aria-label={label} onClick={onOpen}>
        <MonitorSmartphone size={14} aria-hidden="true" />
        {status.data.devices.length}
      </button>
    </Tooltip>
  );
}
