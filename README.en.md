# Double or Die

[Русский](README.md) · English

[![CI](https://github.com/tr0llex/double-or-die/actions/workflows/ci.yml/badge.svg)](https://github.com/tr0llex/double-or-die/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A twin-stick roguelite where **you choose the difficulty yourself** — by
betting on your own performance.

Bet cards lie on the arena during the fight: "no damage", "under 45 seconds",
"no turning left". Picking one up is already a risk — it may sit in a corner
under fire. The bolder the bet, the fatter the pot, and the only one you lose
to is yourself.

Play at **[die.samoy.love](https://die.samoy.love)** (soon).

## How it works

Bets live inside combat, not in menus between rooms. There is deliberately no
selection screen: it pulled the player out of the action thirty times per run
and ate up to half of the early rooms.

The table always has a second player: in co-op that's a friend who can bet
against you; solo it's **Ace**, the house dealer. He wagers his own chips,
haggles over the house cut, and remembers how your last run ended.

## Development

```bash
npm install
npm run dev      # game on localhost:5173
npm test         # unit tests and determinism
npm run sim      # headless runner, no graphics
npm run safety   # is there always somewhere for the player to go
npm run check    # lint, types, module boundaries
```

The simulation is **deterministic**: the same seed and the same inputs produce
the same state on any platform. Replays, daily runs with anti-cheat, golden
tests, Monte-Carlo balancing and online play all fall out of that one decision
for free. Verified in CI across three operating systems.

That is why the core contains no `Math.random`, no `Date.now` and no
`Math.sin` — only fixed-point arithmetic and lookup tables. A linter enforces
this, not good intentions.

## Documentation

Project strategy lives in [`docs/`](docs/) and takes precedence over code:
fifteen documents covering design, economy, difficulty and the release plan.
Written in Russian.

## Status

Version **0.2.0 "Shooting Range"**: combat. The player shoots and dodges,
three enemies — Wedge, Brick and Fuse — arrive in waves sized by a threat
budget, an arena with columns provides cover, and the dead drop chips.
Rendering moved to WebGL2: the whole frame ships in a single draw call, so
hitstop, screen shake, flashes and two thousand particles fit the budget with
room to spare. Audio is synthesised in Web Audio — zero assets.

Bets land in 0.3.0. Until then this is an honest twin-stick with no cards.
