/**
 * Pure route builders shared by execution and diagnostic feedback.
 *
 * 星驰API (https://xingchiapi.com) reads and claims its dashboard check-in on
 * one path, the same path FreeAPI uses with a different DTO. Its axios
 * interceptor appends `?timezone=<IANA>` to every GET, so only the status
 * read carries the reader's timezone.
 */
export const XINGCHI_CHECK_IN_ENDPOINT = "/api/v1/user/checkin"

/** Builds the read-only status path without reading runtime state. */
export function createXingchiCheckInStatusEndpoint(timezone: string): string {
  return `${XINGCHI_CHECK_IN_ENDPOINT}?timezone=${encodeURIComponent(timezone)}`
}

/** Uses the same browser timezone fallback as sibling Sub2API methods. */
export { resolveUserCheckInTimezone as resolveXingchiCheckInTimezone } from "./userCheckInProtocol"
