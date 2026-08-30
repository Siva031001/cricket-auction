/**
 * Payments.gs — registration fee verification.
 *
 * Phase 0: no handlers. This file exists so buildRoutes() in Code.gs can call
 * PaymentRoutes() safely.
 *
 * PHASE 2 — payment verification (DESIGN.md §6.3)
 *   payment.list           ADMIN. Filter by PENDING | VERIFIED | REJECTED.
 *   payment.getScreenshot  ADMIN. Returns a data URI via Drive.getAsDataUri.
 *                          Screenshots live in the never-shared private/ folder
 *                          (CONTRACTS.md §9 rule 2), so this route is the only
 *                          way to see one and it must always check the token.
 *   payment.verify         ADMIN. PENDING -> VERIFIED, makes the player eligible
 *                          for the auction pool. Audited as PAYMENT_VERIFIED.
 *   payment.reject         ADMIN. PENDING -> REJECTED with reject_reason.
 *                          Audited as PAYMENT_REJECTED.
 */

/**
 * Payment route table. Empty in Phase 0.
 * @return {!Object} route table fragment
 */
function PaymentRoutes() {
  return {};
}
