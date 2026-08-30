/**
 * Auction.gs — the locked critical section. Every write here bumps the state
 * version and rebuilds the cached snapshot (DESIGN.md §7).
 *
 * Phase 0: no handlers. This file exists so buildRoutes() in Code.gs can call
 * AuctionRoutes() safely.
 *
 * PHASE 4 — auction core (DESIGN.md §6.5, §6.5a, §6.7)
 *   auction.getBySerial    ORGANISER. Look a player up by serial number.
 *   auction.search         ORGANISER. Free-text over search_blob.
 *   auction.markSold       ORGANISER. Inside Repo.withLock: checks
 *                          PLAYER_NOT_ELIGIBLE, PLAYER_NOT_PENDING,
 *                          ALREADY_ASSIGNED, TEAM_FULL, INSUFFICIENT_PURSE,
 *                          INVALID_AMOUNT and STALE_STATE, then appends to
 *                          AuctionResults and updates the team counters.
 *   auction.markUnsold     ORGANISER. Player returns to the pool for re-auction.
 *   auction.returnToPool   ORGANISER. Undo a sale: refunds the purse and frees
 *                          the squad slot.
 *   auction.correct        ORGANISER. Supersedes an earlier result via
 *                          supersedes_auction_id. Audited as AUCTION_CORRECTED.
 *   auction.state          ORGANISER. The 2-second poll. Returns {same:true}
 *                          when the client's v matches, otherwise the snapshot.
 *   auction.summary        ORGANISER. verified / sold / unsold / pending counts.
 *   auction.history        ORGANISER. Recent results, newest first.
 *
 * markSold, markUnsold, returnToPool and correct all APPEND a new AuctionResults
 * row and flip is_current on the superseded one — that tab is append-only and is
 * never edited (DESIGN.md §2.6).
 *
 * PHASE 5 — projector mode (DESIGN.md §8)
 *   auction.displayState   PUBLIC, GET+POST. Read-only feed, gated on the
 *                          tournament's display_token. No write endpoints.
 *
 * PHASE 7 — closing and reopening (DESIGN.md §6.8)
 *   auction.close          ADMIN. Audited as AUCTION_CLOSED.
 *   auction.reopen         ADMIN. Audited as AUCTION_REOPENED.
 */

/**
 * Auction route table. Empty in Phase 0.
 * @return {!Object} route table fragment
 */
function AuctionRoutes() {
  return {};
}
