import { useCallback, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { consentApi, formatApiError, isRemoteEgressConsentError, type RemoteEgressState } from "@/lib/api";
import { EGRESS_PAYLOAD_CLASSES as PAYLOAD_CLASSES } from "@/lib/egressDisclosure";

function EgressConsentDialog({
  state,
  busy,
  error,
  onAcknowledge,
  onClose,
}: {
  state: RemoteEgressState | null;
  busy: boolean;
  error: string | null;
  onAcknowledge: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" aria-hidden />
            Some data would leave this Mac
          </DialogTitle>
          <DialogDescription>
            The configured model provider is remote
            {state?.endpoint_host ? (
              <>
                {" "}
                (<span className="font-mono text-foreground">{state.endpoint_host}</span>)
              </>
            ) : null}
            . If you continue, the {PAYLOAD_CLASSES} for this workspace are sent to that provider under its privacy
            policy. Parsing, SQL, storage, and report rendering stay on this machine.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="outline" size="sm" asChild disabled={busy}>
            <a href="#/settings">
              <ExternalLink className="h-4 w-4" />
              Open Settings
            </a>
          </Button>
          <Button type="button" size="sm" onClick={onAcknowledge} disabled={busy}>
            {busy ? "Acknowledging…" : "Acknowledge and continue"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Detects the fail-closed remote-egress 403, shows the consent card with the
 * exact destination and payload classes, and resumes the blocked action after
 * an explicit acknowledgment. `handleConsentError` returns false for any other
 * failure so callers keep their normal error path.
 */
export function useEgressConsentGate() {
  const [state, setState] = useState<RemoteEgressState | null>(null);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);

  const handleConsentError = useCallback((error: unknown, onRetry: () => void): boolean => {
    if (!isRemoteEgressConsentError(error)) return false;
    setAckError(null);
    setRetryAction(() => onRetry);
    consentApi
      .get()
      .then(setState)
      .catch(() => setState({ required: true, acknowledged_at: null, endpoint_host: null }));
    return true;
  }, []);

  const close = useCallback(() => setRetryAction(null), []);

  const acknowledge = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setAckError(null);
    try {
      setState(await consentApi.acknowledge());
      const retry = retryAction;
      setRetryAction(null);
      retry?.();
      return true;
    } catch (failure) {
      setAckError(formatApiError(failure, "Could not record your acknowledgment. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }, [retryAction]);

  const dialog = retryAction ? (
    <EgressConsentDialog
      state={state}
      busy={busy}
      error={ackError}
      onAcknowledge={() => void acknowledge()}
      onClose={close}
    />
  ) : null;

  return { handleConsentError, acknowledge, dialog };
}
