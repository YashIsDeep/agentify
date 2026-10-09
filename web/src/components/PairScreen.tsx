import { useMutation } from "@tanstack/react-query";
import { formatPairingCode, normalizePairingCode, PAIR_LINK_KEY, PAIRING_CODE_LENGTH, type SessionInfo } from "@wm/shared";
import { Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { sessionApi } from "../api";
import { Button, Callout, Card, Field, FormStack } from "../ui";

/** The code a pairing link (the QR code) carries in its fragment. */
const codeFromLink = () => new URLSearchParams(window.location.hash.slice(1)).get(PAIR_LINK_KEY) ?? "";

/** As typed: capitals, no spaces, a dash after the fourth character. */
const asTyped = (value: string) =>
  formatPairingCode(value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, PAIRING_CODE_LENGTH));

/** What a device sees until it pairs: one field for the code shown on the computer running Agentify. */
export function PairScreen({ onPaired }: { onPaired: (session: SessionInfo) => void }) {
  const [code, setCode] = useState(() => asTyped(codeFromLink()));
  const pair = useMutation({ mutationFn: sessionApi.pair, onSuccess: onPaired });
  const complete = normalizePairingCode(code).length === PAIRING_CODE_LENGTH;

  // A scanned link pairs straight away. The code leaves the address bar either way, so it isn't left
  // in the history or on screen once used.
  useEffect(() => {
    const linked = codeFromLink();
    if (!linked) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    pair.mutate(linked);
    // Once, for the link the page was opened with.
  }, []);

  return (
    <div className="pair-screen">
      <Card className="pair-card">
        <div className="pair-brand">
          <Workflow size={19} aria-hidden="true" />
          <span>Agentify</span>
        </div>
        <h1 className="pair-title">Pair this device</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (complete && !pair.isPending) pair.mutate(code);
          }}
        >
          <FormStack>
            <Field label="Pairing code" tip="On the computer running Agentify, open Devices and choose Connect a device.">
              <input
                autoFocus
                value={code}
                onChange={(event) => setCode(asTyped(event.target.value))}
                placeholder="XXXX-XXXX"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                autoCorrect="off"
                spellCheck={false}
                maxLength={PAIRING_CODE_LENGTH + 1}
                className="pair-code-input"
              />
            </Field>
            {pair.error && <Callout tone="danger">{pair.error.message}</Callout>}
            <Button type="submit" variant="primary" disabled={!complete} loading={pair.isPending} loadingText="Pairing…">
              Pair
            </Button>
          </FormStack>
        </form>
      </Card>
    </div>
  );
}
