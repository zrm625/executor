import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";

import { authClient } from "./auth-client";
import { fetchSsoProviders, type SsoProvider } from "./auth-config";
import { AuthLayout } from "./auth-layout";
import { postLoginTarget } from "../src/auth/return-to";

const EXTERNAL_OIDC_PROVIDER_ID = "external-oidc";

// Self-host login: email + password sign-in via Better Auth, plus a provider
// button per configured SSO provider (read from /api/auth-config). On
// success we reload so the shared AuthProvider re-reads /account/me and the
// AuthGate swaps in the app. (Cloud's equivalent is a WorkOS redirect — this is
// the provider-specific piece injected into the shared shell.)
//
// There is no self-signup here: open registration is closed. New people join by
// redeeming an invite — either the full /join/<code> link, or by entering the
// code here ("Have an invite code?"), which forwards to the same join page.
export const LoginPage = () => {
  const search = window.location.search;
  // Where to go after sign-in. The gate renders this page IN PLACE of the
  // requested route without navigating, so the live location is what carries a
  // deep link (`/connect/linear`) across sign-in — see `postLoginTarget`.
  const postLogin = postLoginTarget(window.location);
  const [mode, setMode] = useState<"signin" | "code" | "link">("signin");
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<readonly SsoProvider[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchSsoProviders().then((providers) => {
      if (!cancelled) setSsoProviders(providers);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/oidc-status", { headers: { accept: "application/json" } }).then(
      async (response) => {
        const body: unknown = response.ok
          ? await response.json().then(
              (value) => value,
              () => null,
            )
          : null;
        if (
          active &&
          body &&
          typeof body === "object" &&
          "enabled" in body &&
          body.enabled === true
        ) {
          setOidcEnabled(true);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (new URLSearchParams(search).has("error")) {
      setError("External sign-in did not complete. Your local account is unchanged.");
    }
  }, [search]);

  const oidcErrorCallback = `/login?error=oidc&returnTo=${encodeURIComponent(postLogin)}`;

  const startOidcSignIn = async () => {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.oauth2({
      providerId: EXTERNAL_OIDC_PROVIDER_ID,
      callbackURL: postLogin,
      errorCallbackURL: oidcErrorCallback,
      requestSignUp: false,
    });
    if (result.error) {
      setBusy(false);
      setError(result.error.message ?? "External sign-in could not start");
    }
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      setBusy(false);
      setError(result.error.message ?? "Sign in failed");
      return;
    }
    if (mode === "link") {
      const link = await authClient.oauth2.link({
        providerId: EXTERNAL_OIDC_PROVIDER_ID,
        callbackURL: postLogin,
        errorCallbackURL: oidcErrorCallback,
      });
      if (link.error) {
        setBusy(false);
        setError(link.error.message ?? "External account linking could not start");
      }
      return;
    }
    window.location.href = postLogin;
  };

  const signInWithSso = async (providerId: string) => {
    setBusy(true);
    setError(null);
    // Better Auth redirects the browser to the IdP; on callback it lands on
    // `callbackURL`, so the deep-link target survives the round trip the same
    // way it does for the email form's post-login navigation.
    const result = await authClient.signIn.oauth2({
      providerId,
      callbackURL: postLogin,
    });
    if (result.error) {
      setBusy(false);
      setError(result.error.message ?? "Sign in failed");
    }
  };

  const redeem = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    // Forward to the join page, which collects name/email/password and redeems.
    window.location.href = `/join/${encodeURIComponent(trimmed)}`;
  };

  return (
    <AuthLayout>
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {mode === "signin"
              ? "Sign in"
              : mode === "link"
                ? "Link external login"
                : "Join this instance"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {mode === "signin"
              ? "Welcome back. Use your instance account."
              : mode === "link"
                ? "First prove your existing local account, then complete external sign-in."
                : "Enter the invite code you were given."}
          </p>
        </div>

        {mode !== "code" ? (
          <form onSubmit={signIn} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
                autoComplete="current-password"
                required
                minLength={8}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "…" : mode === "link" ? "Continue to identity provider" : "Sign in"}
            </Button>
            {mode === "signin" && ssoProviders.length > 0 && (
              <>
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs text-muted-foreground">or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                {ssoProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void signInWithSso(provider.id)}
                    className="w-full"
                  >
                    Continue with {provider.name}
                  </Button>
                ))}
              </>
            )}
          </form>
        ) : (
          <form onSubmit={redeem} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-code">Invite code</Label>
              <Input
                id="invite-code"
                placeholder="XXXX-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode((e.target as HTMLInputElement).value)}
                autoFocus
              />
            </div>
            <Button type="submit" disabled={!code.trim()} className="w-full">
              Continue
            </Button>
          </form>
        )}

        {oidcEnabled && mode === "signin" && (
          <div className="space-y-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void startOidcSignIn()}
              className="w-full"
            >
              Sign in with identity provider
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMode("link");
                setError(null);
              }}
              className="w-full text-sm font-normal text-muted-foreground hover:text-foreground"
            >
              Link external login to an existing account
            </Button>
          </div>
        )}

        <div className="text-center">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setMode(mode === "signin" ? "code" : "signin");
              setError(null);
            }}
            className="text-sm font-normal text-muted-foreground hover:text-foreground"
          >
            {mode === "signin" ? "Have an invite code? Join" : "Back to sign in"}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
};
