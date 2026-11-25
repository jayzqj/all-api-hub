/**
 * Pure route constants shared by execution and diagnostic feedback.
 *
 * ChatflowsAI (https://ai.chatflowsai.com) serves its check-in page at
 * `/checkin/` and links it from the Sub2API custom menu as
 * `/custom/daily-checkin`. The page reads and writes a sidecar service mounted
 * at the console origin's `/api/checkin` namespace, outside Sub2API's `/api/v1`.
 * Neither request carries a timezone: the service owns its period, which the
 * page documents as resetting at 12:00 Beijing time.
 */
export const CHATFLOWS_AI_CHECK_IN_STATUS_ENDPOINT = "/api/checkin/status"
export const CHATFLOWS_AI_CHECK_IN_ENDPOINT = "/api/checkin"
