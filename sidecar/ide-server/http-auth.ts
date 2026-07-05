/**
 * Bearer-auth guard for the MCP HTTP surface. Uniform empty 401 on any
 * missing/wrong bearer, regardless of path or method — no information
 * leakage about which paths exist or what the expected format is.
 */
export function extractBearer(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export function isAuthorized(header: string | null, token: string): boolean {
  const provided = extractBearer(header);
  return provided !== undefined && provided === token;
}

export function unauthorizedResponse(): Response {
  return new Response(null, { status: 401 });
}
