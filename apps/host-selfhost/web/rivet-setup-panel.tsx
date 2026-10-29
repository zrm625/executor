/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- This component is the browser fetch and keyboard adapter; imperative failures become transient React UI state, outside the Effect domain. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { Button } from "@executor-js/react/components/button";
import {
  decodeSetupStatus,
  setupActive,
  setupInstruction,
  googleSignInRejected,
  localSignInUrl,
  type SetupStatus,
} from "./rivet-setup-state";

const Image = Schema.Struct({
  image: Schema.String,
  endpoint: Schema.optional(Schema.String),
});
const decodeImage = Schema.decodeUnknownSync(Image);

export function RivetSetupPanel(props: { readonly integration: string }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingUntil, setWaitingUntil] = useState(0);
  const base = `/api/rivet-setup/${encodeURIComponent(props.integration)}`;
  const mounted = useRef(true);
  const actionPending = useRef(false);

  const call = useCallback(
    async (route: string, body?: unknown) => {
      const result = await fetch(`${base}/${route}`, {
        credentials: "same-origin",
        cache: "no-store",
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(45_000),
      });
      if (result.status === 404 || result.status === 403 || result.status === 401) {
        if (mounted.current) {
          setAvailable(false);
          setStatus(null);
          setQr(null);
        }
        throw new Error("SETUP_UNAVAILABLE");
      }
      const json: unknown = await result.json();
      if (!result.ok) throw new Error("SETUP_OPERATION_FAILED");
      return json;
    },
    [base],
  );

  const refresh = useCallback(async () => {
    const current = decodeSetupStatus(await call("status"));
    if (mounted.current) {
      setStatus(current);
      if (current.phoneConnected) setQr(null);
    }
    return current;
  }, [call]);

  useEffect(() => {
    mounted.current = true;
    setAvailable(true);
    setStatus(null);
    setQr(null);
    setError(null);
    void (async () => {
      try {
        await refresh();
      } catch {
        if (mounted.current) setError("Could not check Rivet setup. Retry the connection check.");
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const polling = qr !== null || (status !== null && setupActive(status));
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let pending = false;
    const deadline = waitingUntil || status?.google?.expiresAt || Date.now() + 600_000;
    const tick = async () => {
      if (stopped || pending || document.hidden) return;
      if (Date.now() >= deadline) {
        stopped = true;
        setQr(null);
        setError("Setup wait expired. Check the phone or start setup again.");
        return;
      }
      pending = true;
      try {
        await refresh();
        if (!stopped && mounted.current) setError(null);
      } catch {
        if (!stopped && mounted.current)
          setError("Could not refresh setup. Your saved connections are preserved.");
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, 1500);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [polling, call, refresh, waitingUntil, status?.google?.expiresAt]);

  const act = async (operation: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch {
      if (mounted.current) setError("Setup could not finish. Check the connection and retry.");
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (!available) return null;
  if (!status)
    return error ? (
      <section aria-label="Rivet setup">
        <p role="alert">{error}</p>
        <Button
          onClick={() =>
            void act(async () => {
              await refresh();
            })
          }
        >
          Retry setup check
        </Button>
      </section>
    ) : null;
  const active = setupActive(status);
  const handoff = localSignInUrl(status);
  const rejected = googleSignInRejected(status);

  return (
    <section aria-label="Rivet setup" className="space-y-4 rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium">Set up Rivet</h2>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-live="polite">
        <span>
          Phone: <strong>{status.phoneConnected ? "Connected" : "Needs connection"}</strong>
        </span>
        <span>
          Google Messages:{" "}
          <strong>
            {status.googleAuthenticated
              ? "Authenticated"
              : rejected
                ? "Sign-in expired"
                : status.googleConfigured
                  ? "Needs pairing or verification"
                  : "Not configured"}
          </strong>
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{setupInstruction(status)}</p>
      {handoff ? (
        <div className="space-y-2">
          <a
            className="inline-block rounded-md border border-border px-3 py-2 text-sm"
            href={handoff}
          >
            Open Google sign-in on this computer
          </a>
          <p className="text-xs text-muted-foreground">
            Requires the Rivet helper and Chromium installed on this computer. Use your phone's
            passkey, then confirm the Messages emoji. This one-time link expires in ten minutes.
          </p>
          <p className="text-xs text-muted-foreground">
            On a phone? Open this Accounts page on your computer to complete Google sign-in.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!status.phoneConnected && !qr ? (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const image = decodeImage(await call("phone-qr", {}));
                if (
                  image.endpoint !== status.phoneEndpoint ||
                  !/^[A-Za-z0-9+/=]{1,2000000}$/.test(image.image)
                )
                  throw new Error("INVALID_PAIRING_QR");
                setQr(image.image);
                setWaitingUntil(Date.now() + 180_000);
              })
            }
          >
            Connect phone
          </Button>
        ) : null}
        {status.googleConfigured && !status.googleSessionPresent && !active ? (
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await call("google/start", {});
                setWaitingUntil(Date.now() + 600_000);
                await refresh();
              })
            }
          >
            Connect Google Messages
          </Button>
        ) : null}
        {!active ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (status.googleSessionPresent) await call("verify", {});
                await refresh();
              })
            }
          >
            Check connections
          </Button>
        ) : null}
        {active ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await call("google/cancel", { id: status.google!.id });
                await refresh();
              })
            }
          >
            Cancel setup
          </Button>
        ) : null}
        {qr ? (
          <Button variant="outline" onClick={() => setQr(null)}>
            Hide QR
          </Button>
        ) : null}
      </div>
      {qr ? (
        <div className="space-y-2">
          <p className="text-sm">{status.phoneEndpoint}</p>
          <img
            className="w-full max-w-sm bg-white"
            src={`data:image/svg+xml;base64,${qr}`}
            alt="Scan this private QR in Rivet on your phone"
          />
          <p className="text-xs text-muted-foreground">
            This QR contains your pairing key. Keep it private. The page detects the connection
            automatically.
          </p>
        </div>
      ) : null}
      {status.google?.state === "phone_confirmation" && status.google.emoji ? (
        <div className="space-y-2">
          <p>Confirm this emoji in Google Messages on your phone:</p>
          <p className="text-5xl" aria-label="Pairing confirmation emoji">
            {status.google.emoji}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {status.google?.error && !status.googleSessionPresent ? (
        <p role="alert" className="text-sm">
          Google pairing did not complete. Start a new attempt when ready.
        </p>
      ) : null}
      {status.checkedAt ? (
        <p className="text-xs text-muted-foreground">
          Google authentication checked {new Date(status.checkedAt).toLocaleString()}. This is a
          point-in-time check.
        </p>
      ) : null}
    </section>
  );
}
