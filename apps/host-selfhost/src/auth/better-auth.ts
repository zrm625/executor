import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import {
  admin,
  bearer,
  deviceAuthorization,
  genericOAuth,
  mcp,
  organization,
  type GenericOAuthConfig,
} from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { type Client } from "@libsql/client";
import { LibsqlDialect, type LibsqlDialectConfig } from "@libsql/kysely-libsql";
import { Context, Option, Schema } from "effect";

import { loadConfig, type SelfHostOidcConfig } from "../config";
import { seedOrgAndAdmin } from "./seed";
import { consumeInviteCode, ensureInviteCodeTable, findRedeemableCode } from "./invites";

// The self-service signup gate: present only on the live (phase-2) auth
// instance, so the bootstrap seed's `createUser` — which
// runs on the gate-free phase-1 instance — is never blocked. `getAuth` is
// late-bound because the hooks call `auth.api.addMember` AFTER the instance they
// belong to is constructed (the closure resolves it at request time).
interface SignupGate {
  readonly client: Client;
  readonly organizationId: string;
  readonly getAuth: () => Auth | null;
}

// Only self-service email signups are code-gated. Server/admin-initiated user
// creation (the seed, or a future admin "add user") flows through other paths.
const SIGNUP_PATH = "/sign-up/email";
const EXTERNAL_OIDC_USERINFO_TIMEOUT_MS = 5_000;
const EXTERNAL_OIDC_USERINFO_MAX_BYTES = 16 * 1024;
const EXTERNAL_OIDC_SUBJECT_MAX_LENGTH = 255;
const EXTERNAL_OIDC_EMAIL_MAX_LENGTH = 254;
const EXTERNAL_OIDC_NAME_MAX_LENGTH = 256;
const EXTERNAL_OIDC_USERNAME_MAX_LENGTH = 128;
const EXTERNAL_OIDC_PICTURE_MAX_LENGTH = 2_048;
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const strictTrimmedString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  const trimmed = value.trim();
  return trimmed === value && trimmed.length > 0 ? trimmed : null;
};

const optionalStrictTrimmedString = (
  value: unknown,
  maxLength: number,
): string | undefined | null => {
  if (value === undefined) return undefined;
  return strictTrimmedString(value, maxLength);
};

const readBoundedJson = async (response: Response): Promise<unknown | null> => {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;

  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null) {
    const length = Number(advertisedLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > EXTERNAL_OIDC_USERINFO_MAX_BYTES) {
      return null;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > EXTERNAL_OIDC_USERINFO_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return Option.getOrElse(decodeUnknownJson(text), () => null);
};

export const decodeExternalOidcUserInfo = (
  value: unknown,
): { id: string; email: string; emailVerified: true; name: string; image?: string } | null => {
  if (!value || typeof value !== "object") return null;
  const claims = value as Record<string, unknown>;
  const id = strictTrimmedString(claims.sub, EXTERNAL_OIDC_SUBJECT_MAX_LENGTH);
  const rawEmail = strictTrimmedString(claims.email, EXTERNAL_OIDC_EMAIL_MAX_LENGTH);
  if (!id || !rawEmail || !/^[^\s@]+@[^\s@]+$/.test(rawEmail) || claims.email_verified !== true) {
    return null;
  }
  const email = rawEmail.toLowerCase();
  const name = optionalStrictTrimmedString(claims.name, EXTERNAL_OIDC_NAME_MAX_LENGTH);
  const username = optionalStrictTrimmedString(
    claims.preferred_username,
    EXTERNAL_OIDC_USERNAME_MAX_LENGTH,
  );
  if (name === null || username === null) return null;
  const displayName = name ?? username ?? email;
  const picture = optionalStrictTrimmedString(claims.picture, EXTERNAL_OIDC_PICTURE_MAX_LENGTH);
  if (picture === null) return null;
  const imageUrl = picture ? URL.parse(picture) : null;
  if (picture && !imageUrl) return null;
  if (imageUrl && (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password)) {
    return null;
  }
  return {
    id,
    email,
    emailVerified: true,
    name: displayName,
    ...(imageUrl ? { image: imageUrl.href } : {}),
  };
};

export const makeExternalOidcConfig = (oidc: SelfHostOidcConfig): GenericOAuthConfig => ({
  providerId: oidc.providerId,
  issuer: oidc.issuer,
  requireIssuerValidation: true,
  authorizationUrl: oidc.authorizationUrl,
  tokenUrl: oidc.tokenUrl,
  userInfoUrl: oidc.userInfoUrl,
  clientId: oidc.clientId,
  clientSecret: oidc.clientSecret,
  scopes: ["openid", "profile", "email"],
  responseType: "code",
  pkce: true,
  authentication: "basic",
  disableImplicitSignUp: true,
  disableSignUp: true,
  overrideUserInfo: false,
  // Better Auth's generic plugin otherwise decodes ID-token claims without
  // verifying their signature. Always obtain identity from the operator-pinned
  // HTTPS UserInfo endpoint instead, and require a stable subject plus a
  // provider-verified email before linking or signing in.
  getUserInfo: async (tokens) => {
    if (!tokens.accessToken) return null;
    const response = await fetch(oidc.userInfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(EXTERNAL_OIDC_USERINFO_TIMEOUT_MS),
    }).then(
      (value) => value,
      () => null,
    );
    if (!response?.ok) return null;
    const body = await readBoundedJson(response).then(
      (value) => value,
      () => null,
    );
    return decodeExternalOidcUserInfo(body);
  },
});

// ---------------------------------------------------------------------------
// Better Auth instance over the SAME libSQL CONNECTION as the FumaDB executor
// tables ("one connection, two schema regions").
//
// Schema-at-boot: passing `{ dialect: new LibsqlDialect({ client }), type:
// "sqlite" }` makes Better Auth's createKyselyAdapter take its `"dialect" in db`
// branch (no native dep, no bun:sqlite); `runMigrations()` creates the auth
// tables idempotently. `makeAuthOptions` is the single source of truth so the
// migrator and runtime instance never drift.
//
// CRITICAL: LibsqlDialect is handed SelfHostDb's EXISTING `@libsql/client` (the
// `{ client }` config branch), NOT a fresh `{ url }` connection. This is the
// crux of the self-host data-loss fix: libSQL connections each manage their own
// `-wal`/`-shm`, and when Better Auth opened a SECOND connection to the same
// file (`{ url }`), its open unlinked SelfHostDb's `-wal`/`-shm` and created new
// ones — orphaning SelfHostDb onto a now-deleted WAL inode. Every executor-core
// write (integrations, connections, tools) then landed in that deleted inode
// and vanished on the next restart, while Better Auth's own writes (on the live
// WAL) survived — the "reconnected account, zero tools" bug, reproducing even
// after the throwaway-bootstrap-instance fix because the LONG-LIVED auth
// connection unlinked it just the same. Sharing one client means one WAL: no
// unlink, and SelfHostDb's foreign_keys/WAL/busy_timeout PRAGMAs now cover auth
// queries too (same connection). `{ client }` sets closeClient=false, so the
// dialect never closes the handle — SelfHostDb owns the file lifecycle and
// closes its client at shutdown. NEVER call .destroy() during normal operation.
//
// We build exactly ONE auth instance, held for the process lifetime. An earlier
// design also built a throwaway "bootstrap" instance (discarded mid-boot); that
// is gone too — the org id is late-bound the same way the signup gate's
// `getAuth` already is, so no second instance is ever needed.
//
// `satisfies BetterAuthOptions` (not a return annotation) keeps the literal
// plugin tuple so `betterAuth` infers the plugin-augmented `auth.api` and
// session/user shapes (activeOrganizationId, role, createUser, ...).
// ---------------------------------------------------------------------------

const makeAuthOptions = (client: Client, getOrganizationId: () => string, gate?: SignupGate) => {
  const config = loadConfig();
  // Always resolved (generated + persisted when no env is set); this guards only
  // an explicitly-set env secret that is too weak.
  const secret = config.authSecret;
  if (secret.length < 32) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a multi-user auth server must not boot with a weak session secret
    throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET), if set, must be at least 32 characters");
  }
  return {
    // Hand Better Auth the SAME libSQL client SelfHostDb already opened — NOT a
    // fresh `{ url }` connection. `{ client }` makes LibsqlDialect adopt the
    // existing handle (closeClient=false, so SelfHostDb keeps ownership). One
    // connection means one WAL: see the header comment for why a second
    // connection is the self-host data-loss bug.
    //
    // The cast bridges a dependency skew: @libsql/kysely-libsql pins an older
    // @libsql/core (0.8) than @libsql/client (0.17), so the two `Client` types
    // differ — only in `.sync()` (embedded-replica replication, unused here).
    // The dialect calls execute/batch/transaction/close, which are identical
    // across both versions, so sharing the 0.17 client is sound at runtime.
    database: {
      // oxlint-disable-next-line executor/no-double-cast -- boundary: the two @libsql/core versions' Client types are structurally identical for the calls the dialect makes (see above); no schema/decode applies to a native client handle.
      dialect: new LibsqlDialect({ client } as unknown as LibsqlDialectConfig),
      type: "sqlite" as const,
    },
    secret,
    // The browser Origin must match this exactly; CLI/MCP bearer requests carry
    // no Origin and are unaffected. `config.webBaseUrl` resolves from an explicit
    // EXECUTOR_WEB_BASE_URL, else a platform-injected origin (Railway/Render/Fly/
    // …), else localhost — so a PaaS deploy is zero-config and any other host
    // sets the one variable (a loud warning fires on the localhost fallback).
    // See config.ts. We deliberately do NOT derive this from the request `Host`:
    // matching the ecosystem (Windmill `BASE_URL`, n8n `WEBHOOK_URL`), a pinned
    // origin keeps host-header injection out of OAuth redirects and links.
    baseURL: config.webBaseUrl,
    trustedOrigins: [config.webBaseUrl],
    emailAndPassword: { enabled: true },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    // `apiKey` issues long-lived personal keys (the API-keys page). With
    // `enableSessionForAPIKeys`, presenting a key resolves to its owner's
    // session — so a key works as a Bearer token for the API + MCP endpoint.
    //
    // `mcp()` adds the MCP OAuth Authorization Server: dynamic client
    // registration + authorize + token under /api/auth/mcp/*, the discovery
    // docs, and `getMcpSession` (opaque-bearer validation). It WRAPS
    // oidcProvider — do NOT also add oidcProvider. The two root well-known docs
    // are re-emitted by the shared envelope (MCP clients probe the origin root,
    // not the /api/auth basePath).
    plugins: [
      organization(),
      admin(),
      apiKey({ enableSessionForAPIKeys: true, rateLimit: { enabled: false } }),
      bearer(),
      // Additive normal-plane browser login. With no OIDC configuration this
      // plugin has no provider and local email/password remains the exact
      // rollback path. New OIDC users cannot be created, and a matching email
      // is never linked implicitly: the user must first authenticate locally
      // and deliberately invoke the plugin's session-gated /oauth2/link flow.
      genericOAuth({ config: config.oidc ? [makeExternalOidcConfig(config.oidc)] : [] }),
      // RFC 8628 device authorization, the CLI `executor login` flow. Registers
      // /device/code + /device/token + the approval endpoints; the issued token
      // is an opaque session that `bearer()` (above) accepts as `Authorization:
      // Bearer` on the /api/* plane. `validateClient` is left unset, so any
      // client_id is accepted (the CLI presents "executor-cli"). `verificationUri`
      // is the page the user opens to confirm the code — the self-host app serves
      // it at /device (this is also the Better Auth default; pinned for clarity).
      deviceAuthorization({ verificationUri: "/device" }),
      // `consentPage` makes the MCP authorize flow redirect to a human approval
      // screen instead of auto-issuing a code — but ONLY when the request
      // carries `prompt=consent`. MCP clients don't send that, so the self-host
      // serving layer injects it on every authorize (see resolveAuthProviders'
      // force-mcp-consent shim); together they force an approval step for every
      // connecting client. The page itself is the SPA route `/mcp-consent`.
      // `loginPage` in oidcConfig is required by the type but the mcp() plugin
      // overrides it with the top-level one; `consentPage` is what we're after.
      mcp({
        loginPage: "/login",
        oidcConfig: { loginPage: "/login", consentPage: "/mcp-consent" },
      }),
    ],
    databaseHooks: {
      // Generic OAuth stores the raw ID token even when encryptOAuthTokens is
      // enabled. Executor never needs it after verified UserInfo is resolved,
      // so scrub it on both initial link and subsequent sign-in refresh. Access
      // and refresh tokens continue through Better Auth's AES-256-GCM storage.
      account: {
        create: {
          before: async (account: Record<string, unknown>) => ({
            data: { ...account, idToken: null },
          }),
        },
        update: {
          before: async (account: Record<string, unknown>) => ({
            data: { ...account, idToken: null },
          }),
        },
      },
      session: {
        create: {
          // Single-org instance: pin every session to the one organization, so
          // every authenticated user resolves to the org scope. The org id is
          // read late (the seed resolves it AFTER this instance is built — see
          // buildBetterAuth); no session is created during the seed, so the
          // empty initial value is never observed.
          before: async (session: Record<string, unknown>) => ({
            data: { ...session, activeOrganizationId: getOrganizationId() },
          }),
        },
      },
      // The signup gate. First-run: an org with ZERO members is unclaimed, so
      // the first signup is admitted ungated and becomes the owner. After that,
      // `before` rejects a signup without a valid, unused, unexpired invite code
      // and `after` makes the new user a real `member` + burns the code.
      ...(gate
        ? {
            user: {
              create: {
                before: async (_user, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  if (await orgHasNoMembers(gate)) return; // first user claims the org
                  const code = inviteCodeFrom(context);
                  if (!code) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "An invite code is required to sign up.",
                    });
                  }
                  if (!(await findRedeemableCode(gate.client, code))) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a Better Auth create hook rejects a request by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "That invite code is invalid, already used, or expired.",
                    });
                  }
                },
                after: async (user, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  const auth = gate.getAuth();
                  if (!auth) return;
                  // First user into an empty org becomes its owner (no code).
                  if (await orgHasNoMembers(gate)) {
                    await auth.api.addMember({
                      body: { userId: user.id, role: "owner", organizationId: gate.organizationId },
                    });
                    return;
                  }
                  const code = inviteCodeFrom(context);
                  if (!code) return;
                  const redeemable = await findRedeemableCode(gate.client, code);
                  if (!redeemable) return;
                  await auth.api.addMember({
                    body: {
                      userId: user.id,
                      role: redeemable.role,
                      organizationId: gate.organizationId,
                    },
                  });
                  await consumeInviteCode(gate.client, code, {
                    usedBy: user.id,
                    usedByEmail: user.email,
                  });
                },
              },
            },
          }
        : {}),
    },
  } satisfies BetterAuthOptions;
};

// The invite code rides on the signup request body (`{ name, email, password,
// inviteCode }`); Better Auth reads the body loosely, so a non-schema field
// survives to the create hook's endpoint context.
const inviteCodeFrom = (context: { body?: unknown }): string | undefined => {
  const body = context.body;
  if (body && typeof body === "object" && "inviteCode" in body) {
    const code = (body as { inviteCode?: unknown }).inviteCode;
    if (typeof code === "string" && code.trim().length > 0) return code;
  }
  return undefined;
};

// Count org members via Better Auth's OWN adapter. Now that auth shares
// SelfHostDb's libSQL client (one connection), this no longer guards against a
// cross-connection snapshot lag — that lag is gone with the second connection.
// It stays the canonical read because the adapter already models the `member`
// table and the count gates the first-run claim; reading through it keeps the
// gate logic next to the writes.
export const countOrgMembers = (auth: Auth, organizationId: string): Promise<number> =>
  auth.$context.then(({ adapter }) =>
    adapter.count({ model: "member", where: [{ field: "organizationId", value: organizationId }] }),
  );

// True when the single org has no members yet — the unclaimed first-run state.
const orgHasNoMembers = async (gate: SignupGate): Promise<boolean> => {
  const auth = gate.getAuth();
  if (!auth) return true;
  return (await countOrgMembers(auth, gate.organizationId)) === 0;
};

const createAuthInstance = (client: Client, getOrganizationId: () => string, gate?: SignupGate) =>
  betterAuth(makeAuthOptions(client, getOrganizationId, gate));

export type Auth = ReturnType<typeof createAuthInstance>;

export interface BetterAuthHandle {
  readonly auth: Auth;
  readonly organizationId: string;
  readonly organizationName: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly organizationSlug: string;
  readonly oidcEnabled: boolean;
  readonly handler: (request: Request) => Promise<Response>;
}

export class BetterAuth extends Context.Service<BetterAuth, BetterAuthHandle>()(
  "@executor-js/host-selfhost/BetterAuth",
) {}

/**
 * Build the single Better Auth instance: migrate, seed the org+admin, and pin
 * the resolved org id into the (late-bound) session hook and signup gate.
 * runMigrations and the seed are idempotent, so this is safe on every boot.
 *
 * One instance, not two: the org id the session-pin and gate need isn't known
 * until the seed creates the org, but both read it lazily (a ref, like the
 * gate's `getAuth`), so there's no need for a throwaway bootstrap instance —
 * and so no second libSQL connection to be GC-closed mid-boot and unlink the
 * shared WAL (see the header comment; that was the self-host data-loss bug).
 *
 * The gate is active during the seed, but its hooks only act on the
 * `/sign-up/email` path — the seed's admin `createUser`/`createOrganization`
 * pass straight through, exactly as the old gate-free bootstrap instance did.
 *
 * `client` is SelfHostDb's libSQL connection. Better Auth's LibsqlDialect is
 * built on this SAME client (not a fresh `{ url }` one — see the header
 * comment's data-loss note), so auth tables and executor tables share one
 * connection and one WAL. The seed also uses it directly for its two
 * idempotency reads against the auth tables Better Auth just migrated.
 */
export const buildBetterAuth = async (client: Client): Promise<BetterAuthHandle> => {
  const config = loadConfig();

  // The org id is resolved by the seed below, AFTER this instance is built; the
  // session-pin hook and the gate read it through these late-bound accessors
  // (no session is created during the seed, so the empty initial id is never
  // observed). `getAuth` resolves to this very instance, so the gate's `after`
  // hook can call `auth.api.addMember` once a code is redeemed.
  let auth: Auth | null = null;
  const orgRef = { id: "" };
  const gate: SignupGate = {
    client,
    get organizationId() {
      return orgRef.id;
    },
    getAuth: () => auth,
  };

  auth = createAuthInstance(client, () => orgRef.id, gate);
  // `runMigrations()` flows through the LibsqlDialect and is idempotent.
  await (await auth.$context).runMigrations();
  await ensureInviteCodeTable(client);
  const { organizationId, organizationName } = await seedOrgAndAdmin(auth, client, config);
  orgRef.id = organizationId;

  return {
    auth,
    organizationId,
    organizationName,
    organizationSlug: config.orgSlug,
    oidcEnabled: config.oidc !== undefined,
    handler: auth.handler,
  };
};
