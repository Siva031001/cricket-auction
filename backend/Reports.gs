/**
 * Reports.gs — admin dashboard numbers and CSV export.
 *
 * Phase 0: no handlers. This file exists so buildRoutes() in Code.gs can call
 * ReportRoutes() safely.
 *
 * PHASE 2 — admin dashboard
 *   dashboard.adminStats   ADMIN. Registration, payment and auction counts for
 *                          one tournament, or across all of them.
 *
 * PHASE 6 — export (DESIGN.md §10)
 *   report.export          ADMIN. Three CSVs: Player List, Team Report, Auction
 *                          Report. Built server-side as a string and returned
 *                          base64 so the browser can trigger the download.
 *                          Two rules that break Excel if ignored:
 *                            - money is a plain integer, no symbol, no commas;
 *                            - mobile numbers are written as ="9876543210".
 *                          CSV generation is slow, so it must never run inside
 *                          Repo.withLock (DESIGN.md §7.1).
 */

/**
 * Report route table. Empty in Phase 0.
 * @return {!Object} route table fragment
 */
function ReportRoutes() {
  return {};
}
