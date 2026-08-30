/**
 * Teams.gs — teams, purse and squad size.
 *
 * Phase 0: no handlers. This file exists so buildRoutes() in Code.gs can call
 * TeamRoutes() safely.
 *
 * PHASE 3 — teams and purse (DESIGN.md §6.4)
 *   team.create            ORGANISER (and ADMIN). Seeds purse_total and
 *                          max_players from the tournament defaults.
 *   team.update            ORGANISER. Editable mid-auction, so it must reject
 *                          SQUAD_BELOW_COUNT and PURSE_BELOW_SPENT.
 *   team.list              ORGANISER. Includes remaining purse and players_count.
 *   team.squad             ORGANISER. The players bought by one team.
 *   team.delete            ORGANISER. Refuses with TEAM_NOT_EMPTY when the team
 *                          has players.
 *                          NOTE: not named in DESIGN.md §4.1, but implied by the
 *                          TEAM_NOT_EMPTY error code (CONTRACTS.md §3) and the
 *                          TEAM_DELETED audit action (§10). Confirm before build.
 */

/**
 * Team route table. Empty in Phase 0.
 * @return {!Object} route table fragment
 */
function TeamRoutes() {
  return {};
}
