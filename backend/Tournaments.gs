/**
 * Tournaments.gs — tournament CRUD, public tournament info, and the organiser
 * accounts that belong to a tournament.
 *
 * Phase 0: no handlers. This file exists so buildRoutes() in Code.gs can call
 * TournamentRoutes() safely.
 *
 * PHASE 1 — tournament setup and the public registration landing page
 *   tournament.getPublic   PUBLIC, GET+POST. Name, photos, fee, QR, rules and
 *                          whether registration is open. Nothing else (§46).
 *   tournament.create      ADMIN. Creates the row, Drive folders and display_token.
 *   tournament.update      ADMIN.
 *   tournament.list        ADMIN.
 *   tournament.get         ADMIN. Full row, unlike getPublic.
 *   tournament.setStatus   ADMIN. DRAFT | REG_OPEN | REG_CLOSED | AUCTION_LIVE |
 *                          AUCTION_CLOSED. Also how registration gets closed.
 *
 * PHASE 3 — organiser access (DESIGN.md §5.4)
 *   organiser.create       ADMIN. Issues the one-time join link.
 *   organiser.list         ADMIN.
 *   organiser.disable      ADMIN.
 *   NOTE: DESIGN.md §4.1 groups organiser.* under "Admin" without naming a file.
 *   They live here because an organiser is scoped to exactly one tournament.
 *   The matching auth.organiserLink route stays in AuthRoutes() in Code.gs.
 */

/**
 * Tournament route table. Empty in Phase 0.
 * @return {!Object} route table fragment
 */
function TournamentRoutes() {
  return {};
}
