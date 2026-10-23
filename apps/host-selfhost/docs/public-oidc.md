# Use a public OIDC client with PKCE

Selfhost SSO supports an explicit public-client mode. Set
`EXECUTOR_SSO_PUBLIC_CLIENT=true`, configure `EXECUTOR_SSO_CLIENT_ID`,
`EXECUTOR_SSO_PROVIDER_ID`, `EXECUTOR_SSO_DISCOVERY_URL`, and
`EXECUTOR_SSO_ALLOWED_DOMAINS`, and omit `EXECUTOR_SSO_CLIENT_SECRET`.
Register `/api/auth/oauth2/callback/PROVIDER_ID` at the configured canonical
browser origin as the IdP redirect URI. Authorization uses PKCE.

Public mode refuses a supplied client secret. Without the public-mode flag,
confidential SSO still requires the client ID and secret together. Provider names
and discovery presets retain their current behavior. Password login, first-run
setup, invite admission, and account-linking policy retain current main behavior.

The IdP must verify the user's email, and its domain must be allowlisted before a
new account is admitted. New admitted accounts receive membership under the existing
SSO rules. Public PKCE does not make an arbitrary issuer account an instance owner
or automatically link it to an unverified bootstrap identity.

Public PKCE preserves password login and existing account-linking policy. Configure
the current SSO variables under separate operator authority; source changes do not
alter deployed settings. The Okta emulator tests exercise public and confidential
discovery, authorization, callback, admission denial, and membership using synthetic
accounts. New public-client tests use a private per-run hosted instance created
through `/_emulate/instances` and assert authorize/token request-ledger evidence,
including PKCE and omission of the client secret. That test requires the synthetic
hosted control plane to be reachable; a local in-process IdP is not its substitute.
