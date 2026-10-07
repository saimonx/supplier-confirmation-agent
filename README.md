# Supplier confirmation agent

An agent that confirms every booked service with its supplier, without a human
in the loop unless it is needed: hotels by email, activities and transfers by
WhatsApp. It is an extract of the operations platform
behind [NomadFlight](https://nomadflight.com), a travel agency that sells
round-the-world and multi-destination trips, where it runs in production.

Every booked hotel, activity and transfer creates a "confirmation" task. Before
this agent existed, a person wrote to each supplier, chased the answer and read
it. In peak season that took a full morning. Now the agent does it and a person
only steps in when a supplier does not answer in time.

## What it does: hotels, by email

1. **Decides** whether the task is due and safe to automate (`src/automationRules.js`).
   Pure functions, no database, no network.
2. **Writes to the hotel** in Spanish or English, picked from the hotel's time
   zone, phone prefix and email domain (`src/language.js`, `src/hotelRules.js`).
3. **Watches Gmail** for replies and bounces. Replies from another address on the
   same domain only count if they mention a guest surname or booking reference.
4. **Classifies the reply** with an LLM using strict structured output:
   `confirmed_all`, `not_found`, `discrepancy`, `question` or `other`, plus the
   confirmation number, differences and missing information (`src/hotelAgent.js`).
5. **Closes the task itself** only when `isSafeAutoConfirmation` holds: category
   `confirmed_all`, high confidence, no differences, nothing missing.
6. **Recovers from bounces**: searches the web for the hotel's official
   reservations email and resends once. No customer data is sent to web search.
7. **Escalates everything else to a human on Telegram** (`src/telegramReview.js`).
   The operator can accept with one tap, or reply with instructions; the agent
   drafts the email in the hotel's language and sends it only after an explicit
   "Send".

## What it does: activities and transfers, by WhatsApp

Drivers and local operators answer WhatsApp, not email (`src/whatsappConfirmation.js`).

1. **24 hours before the service**, at any hour, the agent sends the supplier an
   approved WhatsApp template in Spanish or English with the service, date, time,
   pickup and passengers.
2. **The supplier's reply reaches the operator on Telegram** with the context
   attached: which booking it answers, or the list of pending confirmations when
   one supplier has several open.
3. **Delivery failures are caught**: if WhatsApp reports the message undeliverable,
   the task is marked urgent and the operator gets the supplier's phone to call.

This path uses no LLM. Templates and rules are enough, so adding a model would
only add cost and risk.

## Design choices

- **The model never writes to the database.** It returns a classification; plain
  code decides what happens next and is the only thing that changes state.
- **Rules are separated from I/O.** `automationRules.js` and `hotelRules.js` are
  pure, so every decision is unit-tested without mocks.
- **Idempotent by construction.** A task is claimed atomically before any action,
  so two overlapping runs cannot email the same hotel twice. A task stuck in
  `processing` is released after 30 minutes.
- **Nothing reaches a hotel without a deterministic check or a human "Send".**
- **Every step is logged on the task** (`automation.log`), so any outcome can be
  explained afterwards.

## Layout

```
src/
  automationRules.js   when a task runs, is left manual, or is discarded
  automation.js        orchestrator: claim task, act, follow up, close or escalate
  hotelRules.js        email building, reply matching, schemas, validation
  hotelAgent.js        Gmail send/search, LLM classification, drafting, web search
  telegramReview.js    human-in-the-loop review over Telegram
  whatsappConfirmation.js  WhatsApp templates, reply context, delivery failures
  language.js          language detection for the hotel
  gmailMessageNormalizer.js
  openaiConfig.js
  adapters/            interfaces to the rest of the platform (not included)
test/
```

`src/adapters/` holds the seams to the host application (Mongoose models, Gmail
client, WhatsApp client, Telegram bot, customer email senders). They are stubs here; the tests
inject fakes.

## Run the tests

```bash
npm install
npm test
```

The tests make no network calls and need no API key.

## Using this in your own system

This is an extract, not a package: it runs inside a larger platform. To plug it
into yours:

1. Copy `.env.example` to `.env` and fill it in.
2. Implement the modules in `src/adapters/`: your data models, a Gmail client,
   a WhatsApp Cloud API client, a Telegram bot and your customer email senders.
   Each stub says what it is expected to provide.
3. Call `runAutoTaskAutomations()` in `src/automation.js` from your scheduler (every 30
   minutes in production) and route Telegram updates to `src/telegramReview.js`.

## Notes

User-facing strings (emails, WhatsApp and Telegram messages, model prompts) are in
Spanish, as in production. The
stack is Node.js with the OpenAI Responses API; the scheduler that runs the
agent every 30 minutes and the rest of the platform are not part of this extract.

Built with Claude Code and Codex.
