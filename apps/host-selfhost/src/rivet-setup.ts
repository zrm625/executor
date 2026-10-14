/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-promise-reject, executor/no-promise-catch -- Owner management is a Node HTTP and credential-file boundary. Failures return fixed machine codes. */
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Schema } from "effect";

import type { BetterAuthHandle } from "./auth/better-auth";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface RivetSetupConfig {
  readonly endpoint: string;
  readonly tokenFile: string;
  readonly ownerId: string;
  readonly integration: string;
  readonly browserOrigin: string;
}

export function rivetSetupConfig(): RivetSetupConfig | null {
  let configured: Partial<RivetSetupConfig> = {};
  const path = process.env.EXECUTOR_RIVET_SETUP_CONFIG_FILE;
  if (path) {
    if (!isAbsolute(path)) throw new Error("Invalid Rivet setup configuration path");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 16_384
      )
        throw new Error("Invalid Rivet setup configuration file");
      const value: unknown = decodeJson(readFileSync(fd, "utf8"));
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([key, field]) =>
            !["endpoint", "tokenFile", "ownerId", "integration", "browserOrigin"].includes(key) ||
            typeof field !== "string",
        )
      )
        throw new Error("Invalid Rivet setup configuration fields");
      configured = value;
    } finally {
      closeSync(fd);
    }
  }
  const endpoint = configured.endpoint ?? process.env.EXECUTOR_RIVET_SETUP_ENDPOINT;
  const tokenFile = configured.tokenFile ?? process.env.EXECUTOR_RIVET_SETUP_TOKEN_FILE;
  const ownerId = configured.ownerId ?? process.env.EXECUTOR_RIVET_SETUP_OWNER_ID;
  const origin = configured.browserOrigin ?? process.env.EXECUTOR_WEB_BASE_URL;
  if (!endpoint || !tokenFile || !ownerId || !origin) return null;
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/setup" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    ) ||
    !isAbsolute(tokenFile) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId)
  )
    throw new Error("Invalid Rivet setup configuration");
  return {
    endpoint,
    tokenFile,
    ownerId,
    integration: configured.integration ?? process.env.EXECUTOR_RIVET_SETUP_INTEGRATION ?? "rivet",
    browserOrigin: new URL(origin).origin,
  };
}

function setupToken(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 128
    )
      throw new Error("Invalid setup credential file");
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid setup credential");
    return token;
  } finally {
    closeSync(fd);
  }
}

const privateNetwork = new BlockList();
privateNetwork.addSubnet("127.0.0.0", 8, "ipv4");
privateNetwork.addAddress("::1", "ipv6");
privateNetwork.addSubnet("10.0.0.0", 8, "ipv4");
privateNetwork.addSubnet("172.16.0.0", 12, "ipv4");
privateNetwork.addSubnet("192.168.0.0", 16, "ipv4");
privateNetwork.addSubnet("100.64.0.0", 10, "ipv4");
privateNetwork.addSubnet("fc00::", 7, "ipv6");

export const isPrivateSetupAddress = (address: string): boolean => {
  const family = isIP(address);
  return family !== 0 && privateNetwork.check(address, family === 6 ? "ipv6" : "ipv4");
};

async function setupRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: string,
) {
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPrivateSetupAddress(entry.address)))
    throw new Error("Private setup destination required");
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return new Promise<{ status: number; value: unknown }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers,
        signal: AbortSignal.timeout(40_000),
        family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      (upstream) => {
        // No redirects, including redirects to another private host. TLS still
        // validates the configured hostname while DNS stays pinned for this request.
        if (!upstream.statusCode || (upstream.statusCode >= 300 && upstream.statusCode < 400)) {
          upstream.destroy();
          reject(new Error("Invalid setup response"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        upstream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            upstream.destroy(new Error("Setup response too large"));
            return;
          }
          chunks.push(chunk);
        });
        upstream.on("error", reject);
        upstream.on("end", () => {
          try {
            const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            resolve({ status: upstream.statusCode ?? 502, value: decodeJson(raw) });
          } catch {
            reject(new Error("Invalid setup response"));
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

const routes = new Map([
  ["status", "GET"],
  ["phone-qr", "POST"],
  ["verify", "POST"],
  ["google/start", "POST"],
  ["google/cancel", "POST"],
]);
const response = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** Separate owner management bridge; normal MCP credentials never enter this path. */
export function makeRivetSetupHandler(
  betterAuth: BetterAuthHandle,
  config: () => RivetSetupConfig | null = rivetSetupConfig,
) {
  return async (request: Request): Promise<Response> => {
    let settings: RivetSetupConfig | null;
    try {
      settings = config();
    } catch {
      return response(503, { error: "SETUP_CONFIGURATION_INVALID" });
    }
    if (!settings) return response(404, { error: "SETUP_NOT_CONFIGURED" });
    const path = new URL(request.url).pathname.match(/^\/api\/rivet-setup\/([^/]+)\/(.+)$/);
    if (!path || path[1] !== settings.integration || routes.get(path[2]!) !== request.method)
      return response(404, { error: "SETUP_ROUTE_NOT_FOUND" });
    // Setup belongs to the explicitly configured account, independent of its
    // instance role. A local admin record must not stand in for an SSO user.
    const session = await betterAuth.auth.api
      .getSession({ headers: request.headers })
      .catch(() => null);
    if (!session) return response(401, { error: "SETUP_OWNER_REQUIRED" });
    if (session.user.id !== settings.ownerId)
      return response(403, { error: "SETUP_OWNER_REQUIRED" });
    let body: string | undefined;
    if (request.method === "POST") {
      if (
        request.headers.get("origin") !== settings.browserOrigin ||
        request.headers.get("content-type") !== "application/json"
      )
        return response(403, { error: "SETUP_SAME_ORIGIN_REQUIRED" });
      const reader = request.body?.getReader();
      if (!reader) return response(400, { error: "SETUP_BODY_REQUIRED" });
      let bytes = new Uint8Array();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (bytes.length + chunk.value.length > 16_384) {
            await reader.cancel();
            return response(413, { error: "SETUP_BODY_TOO_LARGE" });
          }
          const combined = new Uint8Array(bytes.length + chunk.value.length);
          combined.set(bytes);
          combined.set(chunk.value, bytes.length);
          bytes = combined;
        }
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        decodeJson(body);
      } catch {
        return response(400, { error: "INVALID_SETUP_BODY" });
      }
    }
    try {
      const upstream = await setupRequest(
        new URL(`${settings.endpoint}/${path[2]}`),
        request.method,
        {
          Authorization: `Bearer ${setupToken(settings.tokenFile)}`,
          "X-Rivet-Setup-Owner": session.user.id,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
      );
      return response(upstream.status, upstream.value);
    } catch {
      return response(502, { error: "SETUP_SERVICE_UNAVAILABLE" });
    }
  };
}
