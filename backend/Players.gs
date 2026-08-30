/**
 * Players.gs — player registration, validation and the admin player list.
 *
 * Phase 0: no handlers. This file exists so buildRoutes() in Code.gs can call
 * PlayerRoutes() safely.
 *
 * PHASE 1 — registration (DESIGN.md §6.2, §11)
 *   player.checkMobile     PUBLIC. Returns {taken: true|false}. Rate-limited.
 *   player.register        PUBLIC. Photo and payment screenshot arrive as base64
 *                          in the JSON body. Allocates the serial number inside
 *                          the script lock (Repo.nextSerial, §6.2) and creates
 *                          the matching PENDING row in Payments.
 *                          Returns the serial number.
 *
 * PHASE 2 — admin review
 *   player.list            ADMIN. Paged and filterable by payment_status,
 *                          auction_status, team and free-text search_blob.
 */

/**
 * Player route table. Empty in Phase 0.
 * @return {!Object} route table fragment
 */
function PlayerRoutes() {
  return {};
}
