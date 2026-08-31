# Auction day — operations card

Print this. Keep it next to the laptop.

Everything here assumes the tournament has already been created, payments verified, and teams set up. That is `RUNBOOK.md`. This card is the day itself.

---

## Before you leave for the venue

| # | Check | Why |
|---|---|---|
| 1 | Registration is **closed** | Someone registering mid-auction changes the pool underneath you |
| 2 | Every payment is **verified or rejected** — zero pending | Only verified players can be sold. A pending player cannot be called. |
| 3 | All 8 teams exist, with the right purse and squad size | Creating a team mid-auction is possible but not something to discover on stage |
| 4 | Export the **Player List** and **print it** | Your paper backup. Non-negotiable. |
| 5 | Open the projector page and press **F** | Confirm it fills the screen and the text is readable from the back of the hall |
| 6 | Click **Download offline pack** on the auction console | Caches players and photos. Takes a minute. Do it on good wifi, not venue wifi. |
| 7 | Test the phone hotspot | Your fallback when the venue wifi dies. It will. |
| 8 | Charge everything | Laptop, phone, hotspot |

---

## Setting up in the hall

1. Projector laptop → open `/projector/<tournament-id>?k=<display token>` → press **F**.
2. Organiser laptop → open `/organiser/auction`.
3. **Tether the organiser laptop to the hotspot, not the venue wifi.** The projector can be on either; the organiser laptop is the one that must not drop.
4. Admin sets the tournament status to **AUCTION LIVE**.
5. Check both screens show the same team purses before you start.

---

## The loop, per player

```
  Draw the lottery number physically
        ↓
  Type the number into the console, press Enter
        ↓
  Player appears on the projector
        ↓
  Bidding happens in the room, by voice
        ↓
  SOLD  → pick the team, type the amount, read the confirmation, confirm
  UNSOLD → press unsold
        ↓
  Team purses update on both screens
```

**Read the confirmation line before you click.** It says what the team is left with:

> Sell Raj Kumar (#27) to Chennai Warriors for ₹75,000?
> Leaves ₹4,75,000 for 3 slots — ₹1,58,333 per slot.

That line is the only thing standing between a typo and a ruined purse. One extra zero is the most expensive mistake available and the hardest to explain.

---

## When something goes wrong

| Symptom | What it means | Do this |
|---|---|---|
| Amber "reconnecting" dot on the projector | Poll failed, it is retrying | Nothing yet. It recovers on its own. If it persists, switch to the hotspot. |
| **OFFLINE banner** on the console | Three polls failed in a row | Keep going. Sales are recorded locally. **Also write them on paper.** |
| "Screen was out of date" after a sale | Another device changed something | The screen refreshes. Check the player's status, then redo the sale if needed. |
| "Insufficient purse" | The team cannot afford the bid | Read out the real remaining figure. The bid has to come down or another team takes them. |
| "Team is full" | Squad size reached | That team is done. An admin can raise the limit if the rules allow. |
| Amber warning on the amount | Unusually large bid — possibly a typo | Check the number. Tick the box only if it is genuinely right. |
| Wrong result recorded | Human error | Use **Correct** (admin). It never deletes — it records a correction alongside the original. |
| Projector frozen on an old player | Poll is stuck | Press **R** on the projector laptop. |
| Everything is broken | — | **Carry on with paper.** Enter the results afterwards. The auction does not stop. |

---

## When the internet dies

This is the most likely thing to actually go wrong.

1. The console shows the **OFFLINE** banner. Do not stop the auction.
2. Keep recording sales as normal. They queue locally and survive a page reload.
3. **Write every sale on paper as well.** The queue is a convenience; the paper is the record.
4. When the connection returns, the console replays the queue. Each sale is re-checked by the server.
5. **Anything the server rejects is shown to you.** Decide what to do with each one — do not skip this step.
6. Cross-check the replayed results against your paper before continuing.

---

## When to stop

The auction ends when the teams are full, not when the players run out.

With 400 registered and about 100 slots, **roughly 300 players will never be called.** That is normal and expected, not a failure. The console shows a banner when all teams are full:

> All 8 teams are full. 298 players were not called. You can close the auction.

**Say this out loud to the room before the auction starts.** People who paid ₹500 and never heard their number deserve to know beforehand that this was always how it would end.

---

## After the last sale

| # | Step |
|---|---|
| 1 | Admin clicks **Close auction**. Organisers can no longer change results. |
| 2 | Download the **Auction Report**, **Team Report** and **Final Report** |
| 3 | Check the team totals against your paper |
| 4 | If team purses look wrong, run **Recount** — it rebuilds them from the auction history |
| 5 | Save the exports somewhere other than the laptop |
| 6 | Do not delete anything. The audit log settles any argument that comes later. |

---

## Two numbers to know before you start

- **Slots:** 8 teams × 12–13 = about 100
- **Registered:** 400

Everything else follows from those two.
