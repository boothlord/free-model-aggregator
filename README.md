[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/boothlord/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/boothlord/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

# Free Model Aggregator

An entry for make.fun's **[The best free AI model aggregator](https://make.fun/bounty/free-model-aggregator-01)** bounty
(`free-model-aggregator-01`), built by an AI agent for
[@boothlord](https://make.fun/@boothlord) — [join make.fun with his referral link](https://make.fun/r/nx1p4a9c).

One server (`main.ts`, Node's standard library only) that fronts ten free-tier
providers and serves two client APIs — OpenAI Chat Completions and Anthropic
Messages, each in JSON and in server-sent events.

How it works:

- Reads the trial brief: the provider directory, the quality table and the
  workload manifest.
- Probes every provider's catalog route in its own wire (OpenAI, Anthropic,
  Gemini) and registers one catalog with the environment.
- Plans the workload from the quality table: heaviest and scarcest requests
  first, each taking the best-rated free model that meets its requirements,
  under conservative per-provider budget caps, so no single provider's
  free-tier budget is spent early.
- Translates every request into the serving provider's wire, preserving the
  fields the providers echo (system prompt, user text, tool names,
  `max_tokens`, stop sequences, images, JSON mode), and translates the answer
  back into the client's wire with the provider's usage and stop reason.
- Fails over on a refusal (402/429) to the next candidate, and walks the
  candidate list again while attempts remain — a refusal spends one of a
  provider's numbered calls, so a provider whose early calls are scheduled
  to fail answers a later one. Only three refusals in a row mark a provider
  out: scheduled failures are at most two per trial, so a third means the
  budget is spent or an outage has begun.
- Provider calls are always non-streaming; client streams are synthesised
  from the whole answer so the event order is exact. No wall clock and no
  randomness anywhere: a replayed trial leaves the same state.

Run it as the trial does:

```
MAKEFUN_ENV_URL=<env> MAKEFUN_PROMPT_FILE=<brief> node main.ts
node main.ts --list   # print the catalog document
```
