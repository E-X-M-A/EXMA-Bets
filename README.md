# EXMA Bets: a Discord prediction market bot

EXMA Bets is a Polymarket-style prediction market for a single Discord server. Members create yes/no style markets and bet **virtual points** on the outcomes. Winners are paid with a pari-mutuel system. Points have **no real-money value**. There are no payments, no crypto and no external betting services.

- Node.js (≥ 22) · discord.js v14 · SQLite via better-sqlite3
- Slash commands, embeds, buttons, modals and autocomplete
- Every member gets 1,000 points to start and **200 points automatically every day at 00:00 Europe/Berlin**. Nobody has to claim anything.
- Transactional, idempotent ledger. Restart-safe scheduler. 75 automated tests.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure (fill in the values, see "Configuration" below)
cp .env.example .env
$EDITOR .env

# 3. Register the slash commands in your server (re-run after changing commands)
npm run deploy-commands

# 4. Start the bot
npm start

# Run the test suite (uses temporary/in-memory databases, never your real data)
npm test
```

## Discord setup

1. Create an application at <https://discord.com/developers/applications>. Then:
   - **General Information → Application ID** goes in `DISCORD_CLIENT_ID`.
   - **Bot → Reset Token** goes in `DISCORD_TOKEN`. Keep it secret and never paste it into chats or commits.
   - **Bot → Privileged Gateway Intents → enable "Server Members Intent"**. The bot needs it to pay the daily reward to every member, including members who never used the bot.
2. Invite the bot with the `bot` and `applications.commands` scopes. Give it these permissions: **View Channels, Send Messages, Embed Links, Read Message History**. A ready-made URL (replace `CLIENT_ID`):
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=84992`
3. Turn on Developer Mode in Discord (User Settings → Advanced). Then right-click to copy these IDs:
   - the server: `DISCORD_GUILD_ID`
   - the channel where people use commands: `BETTING_CHANNEL_ID`
   - the channel where markets are published: `MARKET_ANNOUNCEMENT_CHANNEL_ID`
4. Optional: make the announcement channel read-only. Deny **Send Messages** and **Use Application Commands** for `@everyone` there, and allow the bot to send. The bet buttons still work for everyone.

## Configuration

All configuration comes from environment variables, usually set in `.env`. Startup fails with a clear message listing every missing or invalid value.

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | required | Bot token |
| `DISCORD_CLIENT_ID` | required | Application ID |
| `DISCORD_GUILD_ID` | required | The only server the bot works in |
| `BETTING_CHANNEL_ID` | required | The only channel where commands are accepted |
| `MARKET_ANNOUNCEMENT_CHANNEL_ID` | required | Where new markets are published with bet buttons |
| `DATABASE_PATH` | `./data/prediction-market.sqlite` | SQLite file. It is created automatically and git-ignored. |
| `INITIAL_BALANCE` | `1000` | Starting balance for new accounts |
| `DAILY_REWARD` | `200` | Automatic daily reward per member (`0` disables it) |
| `MIN_BET` | `10` | Minimum stake |
| `LEADERBOARD_PAGE_SIZE` | `10` | Rows per leaderboard page (1-25) |
| `TIMEZONE` | `Europe/Berlin` | IANA time zone that defines the reward day (DST-aware) |
| `DAILY_MAX_BACKFILL_DAYS` | `7` | Maximum number of missed days (including today) paid out after downtime |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

`.env` and database files are git-ignored. Back up the database by copying the `.sqlite` file while the bot is stopped, or use `sqlite3 data/prediction-market.sqlite ".backup backup.sqlite"` while it runs.

## How it works

### Points

- An account (Discord user ID, never the username) is created on a member's first interaction **or** at the next daily distribution. It starts with `INITIAL_BALANCE`.
- Every balance change is written to the `transactions` ledger in the same database transaction as the balance update. Each ledger row has a unique idempotency key. Balances can never go negative: the code checks this, and so does a `CHECK` constraint in the database.

### Automatic daily rewards (no claim command)

- At **00:00 Europe/Berlin** the bot fetches the full member list of the server (bots excluded). It then credits `DAILY_REWARD` to every member for that calendar day, including members who have never used the bot.
- Each `(user, day)` pair is a primary key in `daily_rewards`, so nobody can be paid twice for one day.
- Each day has a row in `daily_distributions` with its status, recipients, total points, attempts and last error. Members are processed in batches of 250, one transaction per batch. A crash or Discord error mid-run leaves the day `FAILED`/`IN_PROGRESS`, and the next run resumes with only the members not yet paid. A day is marked `COMPLETED` only after every member has been processed.
- If the bot was offline at midnight, the missed days are paid out when it starts again. This is capped by `DAILY_MAX_BACKFILL_DAYS`. Backfilled days go to the members who are in the server when the bot restarts. On a fresh install, distribution starts with the current day.
- A precise midnight timer handles the normal case. A check every 5 minutes catches sleep, clock jumps and failed runs.
- `/admin daily-distribution` shows the status. It is for monitoring only; payouts never depend on it.

### Markets

1. `/market create`: pass the options directly, or leave them empty to get a form. A market has a question, two outcomes, a duration (`30m`, `6h`, `2d`, `7d`, `1d12h`; between 5 minutes and 90 days) and an optional description or resolution criteria.
2. The market is published in the announcement channel with one **Bet** button per outcome and a **My position** button. Every bet updates the embed: pools, participants, implied probabilities and estimated payout multipliers.
3. At the deadline, betting stops. Bets are rejected by timestamp even if the scheduler hasn't run yet. The market moves to `AWAITING_RESOLUTION`, the buttons are disabled, and the creator gets a DM. If DMs are closed, the creator is pinged in the betting channel instead.
4. The creator runs `/market resolve market_id:<id> outcome:<outcome>` and confirms with a button. Payouts happen immediately and the result is posted in the announcement channel.
5. Administrators can **cancel** any unresolved market, which refunds every stake. They can also **resolve** an expired market for an unavailable creator. Both require a reason and are written to `audit_logs`.

Markets currently have exactly two outcomes. Outcomes are stored in a separate `market_outcomes` table, and the settlement math, embeds and buttons all handle N outcomes. Supporting more only requires raising `LIMITS.maxOutcomes` and adding form fields.

### Betting flow

Click **Bet: YES** → enter a stake in the modal (a number, `1,000` or `max`) → review the confirmation, which shows your stake, your balance after the bet and an *estimated* payout → **Confirm**.

The stake is deducted and the bet inserted in one transaction. The confirmation is single-use and belongs to you, so a double click or retried interaction can never charge twice. `/market bet` places a bet directly, keyed by the interaction ID.

Rules: minimum `MIN_BET`, maximum your balance. You can place as many bets as you like, on either outcome. Placed bets are final.

### Payouts (pari-mutuel)

All stakes form one pool. When the market resolves:

- **Winners** get their stake back **plus** a share of the losing pool proportional to their stake: `payout = stake + stake × losingPool / winningPool`.
- **Losers** lose their stakes. The creator gets nothing for creating the market; they win only through their own bets.
- **Nobody bet on the winning outcome:** everyone is refunded.
- **Nobody bet on the losing outcome:** winners get exactly their stake back.
- **No bets:** the market resolves and no points move.
- **Rounding:** shares are rounded down to whole points. The leftover points (always fewer than the number of winning bets) go one each to the bets with the largest fractional remainder; ties go to the oldest bet. Total paid always equals the total pool, so no points are created or lost. This is enforced by a `CHECK` constraint and by tests.

Example: the YES pool is 600 and the NO pool is 400, for a total of 1,000. You bet 100 on YES, and YES wins. You receive `100 + 100 × 400 / 600 = 166.67`, which is 166 or 167 after rounding, for a profit of about +67. Every YES point earns 400/600 ≈ 0.67 extra points. A payout of 200 would only happen if the two pools were equal.

The probabilities shown are each outcome's share of the total stakes. The "Est. payout ≈ 1.66×" figure is `total pool ÷ outcome pool`, rounded down to 2 decimals. Both are **estimates** that change with every bet until betting closes.

## Commands

All normal commands work only in `BETTING_CHANNEL_ID` (threads inside it are allowed). Anywhere else they get a short private redirect. Buttons work in the betting and announcement channels.

| Command | Description |
|---|---|
| `/market create [question outcome_a outcome_b duration description]` | Create a market. With no options, a form opens. |
| `/market list [status] [page]` | Open / awaiting resolution / resolved / cancelled markets, with pagination |
| `/market view market_id` | Full market details, your bets and bet buttons |
| `/market bet market_id outcome amount` | Bet without the buttons |
| `/market resolve market_id outcome` | Creator resolves their expired market (with a confirmation step) |
| `/market history [user]` | The 10 most recent bets with outcomes and payouts |
| `/balance [user]` | Balance, rank and points at stake |
| `/profile [user]` | Balance, total wagered, bets, winning bets, markets created/resolved, net P/L |
| `/leaderboard [type] [page]` | Balance (default), total wagered, net profit/loss or winning bets. Uses button pagination, medals for the top 3, and stable tie-breaking. |
| `/help` | How everything works |

Administrator commands require the Discord **Administrator** permission, which is checked on the server side. They work in any channel of the server:

| Command | Description |
|---|---|
| `/admin market cancel market_id reason` | Cancel and refund all stakes (with confirmation) |
| `/admin market resolve market_id outcome reason` | Resolve an expired market for an absent creator (with confirmation) |
| `/admin market list` | Expired markets still awaiting a result |
| `/admin points add user amount reason` | Grant points |
| `/admin points remove user amount reason` | Remove points (refused if the balance would go negative) |
| `/admin stats` | Users, open/awaiting/resolved/cancelled markets, bets, points in circulation, ledger check |
| `/admin daily-distribution` | Latest daily distributions: status, recipients, points, attempts, errors |

Every administrator action is recorded in the `audit_logs` table.

## Reliability and security

- **Transactions everywhere money moves.** Bets, payouts, refunds, admin adjustments and daily rewards each run in a single `BEGIN IMMEDIATE` transaction. better-sqlite3 is synchronous, so a transaction can never interleave with another interaction. WAL mode with `busy_timeout` serializes writers across processes; a test hammers one account from 4 worker threads.
- **Exactly-once settlement.** `settlements.market_id` is `UNIQUE`, each bet can move from `ACTIVE` only once, and each credit has a per-bet idempotency key (`payout:<betId>`, `refund:<betId>`). A crash mid-settlement rolls back completely.
- **Outbox for Discord side effects.** Creator reminders and result announcements are queued in `notifications` inside the same transaction as the state change. Each one has a unique dedupe key, and failed deliveries are retried with backoff. Embed refreshes use `sync_version`/`synced_version`, so a Discord outage never undoes or blocks a committed transaction.
- **Startup reconciliation.** On start the bot closes expired markets, re-renders stale embeds, delivers pending notifications and pays missed daily rewards. If an announcement of an open market was deleted, it is reposted.
- **Persistent buttons.** Custom IDs are stateless (`pm:bet:<market>:<outcome>`), so buttons keep working after a restart. Every click re-validates market state, expiry, outcome and balance. Outdated buttons get a short explanation.
- **Validation.** All input is validated on the server side, all SQL uses prepared statements, `@everyone`/`@here` are neutralized, and bot messages are sent with mentions disabled except the intended creator ping.
- **Retries and rate limits.** discord.js queues 429 responses. 5xx and network errors are retried with exponential backoff, and permanent errors (missing permissions, deleted channel or message) are reported clearly.
- **No secret leaks.** The token is never logged (it is redacted by the logger). Users see short, actionable errors and never stack traces.
- **Graceful shutdown.** On SIGINT/SIGTERM the bot stops the scheduler, waits for running jobs, disconnects and closes the database.

## Project structure

```
src/
  index.js                 bootstrap, Discord client, startup checks, graceful shutdown
  deploy-commands.js       registers guild slash commands
  config.js                env loading + validation
  database/                connection, pragmas, migrations (schema_migrations table)
  services/                business logic, no Discord dependencies
    userService.js         accounts + idempotent ledger
    marketService.js       creation, validation, expiry, listing
    bettingService.js      atomic bet placement
    settlementService.js   resolution, cancellation, payouts
    marketMath.js          pure pari-mutuel math + odds
    dailyRewardService.js  automatic daily distribution
    statsService.js        leaderboard, profile, history, admin stats
    supportServices.js     audit log, notification outbox, confirmations
  discord/                 embeds/components, publisher, notifier, retries, members
  handlers/                interaction router, access rules, market flows
  commands/                slash command definitions
  scheduler/               expiry, sync, notifications, daily rewards
tests/                     node:test suites (+ fixtures/)
data/                      runtime database (git-ignored)
```

## Tests

`npm test` runs 75 tests with Node's built-in test runner. They cover:

- initial balances and ledger idempotency
- the automatic daily distribution: once per day, crash/resume, missed-day catch-up, the backfill cap, DST boundaries, and that `/daily` does not exist
- insufficient balance and the minimum bet
- concurrent bets from multiple worker threads
- bets after expiry
- pari-mutuel payouts and rounding (500 randomized rounds)
- markets with no bets, with no winning-side bettors, and with one-sided pools
- cancellation refunds, resolution permissions and duplicate settlement prevention
- rollback on a crash mid-settlement
- recovery after a simulated restart
- channel restrictions and custom-ID tampering
- config validation and secret redaction
- an end-to-end run of the real interaction handler against fake Discord objects: create → publish → button → modal → confirm → embed refresh → expiry DM → resolve → announcement, plus admin commands

Tests use in-memory databases or temporary files under the OS temp directory.
