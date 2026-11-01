interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  HANDLE_KEY: string;
  FCM_SERVICE_ACCOUNT: string;
  HANDLE_LIMIT: RateLimit;
  SEND_IP_LIMIT: RateLimit;
  REGISTER_IP_LIMIT: RateLimit;
}

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

const MAX_BODY = 4096;
const MAX_DATA = 1024;
const MAX_TOKEN = 4096;
const MAX_TAG = 64;
const MAX_TTL = 24 * 60 * 60;
// Binds a handle to its purpose, so a ciphertext sealed under the same key for
// anything else can never open as a token.
const HANDLE_AAD = new TextEncoder().encode("tori-relay-handle-v1");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/register" && pathname !== "/send") return text(404, "not found");
    if (request.method !== "POST") return text(405, "POST only");
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ipLimit = pathname === "/register" ? env.REGISTER_IP_LIMIT : env.SEND_IP_LIMIT;
    if (!(await ipLimit.limit({ key: ip })).success) return text(429, "slow down");

    const raw = await request.text();
    if (raw.length > MAX_BODY) return text(413, "body too large");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return text(400, "body is not JSON");
    }
    if (typeof body !== "object" || body === null) return text(400, "body is not an object");
    return pathname === "/register" ? register(body, env) : send(body, env);
  },
};

async function register(body: Record<string, unknown>, env: Env): Promise<Response> {
  const token = body.token;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN) return text(400, "bad token");
  const handle = await seal(token, env.HANDLE_KEY);
  return Response.json({ handle });
}

async function send(body: Record<string, unknown>, env: Env): Promise<Response> {
  const { handle, data, tag, ttl, priority } = body;
  if (typeof handle !== "string") return text(400, "bad handle");
  if (typeof data !== "string" || data.length === 0) return text(400, "bad data");
  if (data.length > MAX_DATA) return text(413, "data too large");
  if (typeof tag !== "string" || tag.length === 0 || tag.length > MAX_TAG) return text(400, "bad tag");
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) return text(400, "bad ttl");
  if (priority !== "high" && priority !== "normal") return text(400, "bad priority");
  const token = await open(handle, await handleKey(env.HANDLE_KEY, "decrypt"));
  if (token === null) return text(400, "bad handle");
  if (!(await env.HANDLE_LIMIT.limit({ key: await digest(handle) })).success) return text(429, "slow down");

  const account: ServiceAccount = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const message = {
    message: {
      token,
      data: { p: data },
      android: { priority: priority === "high" ? "HIGH" : "NORMAL", ttl: `${ttl}s`, collapse_key: tag },
    },
  };
  let sent: Response;
  try {
    sent = await post(account, message, false);
    if (sent.status === 401) sent = await post(account, message, true);
  } catch (e) {
    return text(502, e instanceof OauthError ? e.message : "fcm unreachable");
  }
  if (sent.ok) return new Response(null, { status: 204 });
  if (await unregistered(sent)) return text(410, "token gone");
  return text(502, `fcm ${sent.status}`);
}

async function post(account: ServiceAccount, message: unknown, fresh: boolean): Promise<Response> {
  return fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(account, fresh)}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
}

// FCM answers a token whose app is gone with 404 UNREGISTERED, and only that
// drops the handle: a broader match would let one malformed message here make
// every Mac forget every phone.
async function unregistered(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body = (await response.json().catch(() => null)) as {
    error?: { details?: { errorCode?: string }[] };
  } | null;
  return body?.error?.details?.some((d) => d.errorCode === "UNREGISTERED") ?? false;
}

class OauthError extends Error {}

let cached: { token: string; exp: number } | null = null;

async function accessToken(account: ServiceAccount, fresh: boolean): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!fresh && cached && now < cached.exp - 300) return cached.token;
  const claims = {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(json({ alg: "RS256", typ: "JWT" }))}.${b64url(json(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pem(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(new Uint8Array(signature))}`,
    }),
  });
  if (!response.ok) throw new OauthError(`oauth ${response.status}`);
  const grant = (await response.json()) as { access_token: string; expires_in: number };
  cached = { token: grant.access_token, exp: now + grant.expires_in };
  return grant.access_token;
}

async function handleKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromStandard(secret), "AES-GCM", false, [usage]);
}

async function seal(token: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: HANDLE_AAD },
    await handleKey(secret, "encrypt"),
    new TextEncoder().encode(token),
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return b64url(out);
}

async function open(handle: string, key: CryptoKey): Promise<string | null> {
  try {
    const bytes = fromUrlSafe(handle);
    if (bytes.length <= 12) return null;
    const token = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: HANDLE_AAD },
      key,
      bytes.subarray(12),
    );
    return new TextDecoder().decode(token);
  } catch {
    return null;
  }
}

// Keyed by the full 227 character handle, the limiter never tripped under
// `wrangler dev`; keyed by its digest, it does.
async function digest(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function pem(key: string): Uint8Array {
  return fromStandard(key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromUrlSafe(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return fromStandard(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

function fromStandard(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function text(status: number, message: string): Response {
  return new Response(message, { status });
}
