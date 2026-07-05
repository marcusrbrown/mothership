/**
 * Basic-auth helpers shared by client.ts and sse.ts.
 */

export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type BasicAuthCredentials = { username?: string; password?: string };

export function authHeader(
  credentials: BasicAuthCredentials | undefined,
): Record<string, string> {
  if (!credentials?.password) return {};
  const username = credentials.username ?? "opencode";
  const token = toBase64(`${username}:${credentials.password}`);
  return { Authorization: `Basic ${token}` };
}
