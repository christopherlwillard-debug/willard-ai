import { isIP } from "node:net";
import { timingSafeEqual } from "node:crypto";

export type SetupAuthorization =
  | "local"
  | "authorized"
  | "token_required"
  | "token_invalid"
  | "token_misconfigured";

/** Only requests arriving from the local machine may bypass remote bootstrap credentials. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

/**
 * Hosted/LAN first-run setup requires an operator-provisioned secret.
 * Require at least 32 characters and compare in constant time. Never log
 * either token value. Localhost remains usable for desktop installations.
 */
export function authorizeFirstRunSetup(input: {
  remoteAddress: string | undefined;
  configuredToken: string | undefined;
  suppliedToken: string | undefined;
}): SetupAuthorization {
  if (isLoopbackAddress(input.remoteAddress)) return "local";

  const configured = input.configuredToken;
  if (!configured || configured.length < 32) return "token_misconfigured";
  if (!input.suppliedToken) return "token_required";

  const expected = Buffer.from(configured, "utf8");
  const supplied = Buffer.from(input.suppliedToken, "utf8");
  if (expected.length !== supplied.length) return "token_invalid";
  return timingSafeEqual(expected, supplied) ? "authorized" : "token_invalid";
}
