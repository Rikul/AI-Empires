# AI Empires

A browser-based, ancient-era real-time strategy game in the spirit of classic Age of Empires.
Play **Player vs AI** against an LLM commander, or watch **AI vs AI**: two independently
configured LLM commanders play each other autonomously.

- TypeScript everywhere: shared deterministic simulation, Node server, browser client
- Three.js 3D rendering with original procedural low-poly models (no external assets)
- SQLite persistence (better-sqlite3)
- Any OpenAI-compatible chat-completions endpoint (base URL + model id + optional API key)

## Quick start

```bash
npm install
npm start            # builds the client and serves http://localhost:8080
```

Open http://localhost:8080, click **New match**, choose a mode, map size, biome, seed, population
cap (default 200) and time limit (default 60 simulated minutes), fill in the AI connection(s) and
press **Start match**. Then press **▶** or Space.

- `PORT=9000 npm start` changes the port. `AI_EMPIRES_DB=/path/file.db` changes the database file
  (default `data/ai-empires.db`).
- Development: `npm run dev:server` (API on :8080) and `npm run dev:client` (Vite on :5173 with proxy).

### AI connections

Each AI needs a display name, an OpenAI-compatible **base URL** (e.g. `https://api.openai.com/v1`,
`http://localhost:11434/v1` for Ollama, an OpenRouter/vLLM/LM Studio URL…), a **model id**, and an
optional **API key**. Use **Test connection** to check it. The server makes the requests, so API keys
stay on your machine. They are stored in SQLite with the match so it can be resumed, and are never
sent back to the browser or written to exports.

**Use test commander** fills in a built-in, scripted OpenAI-compatible endpoint (`/mock/v1`). It
reads the same observation a real model gets and answers in the same JSON format. It is meant for
trying the game and for automated tests without an LLM. It is not an LLM.

## Playing

| Action | Control |
|---|---|
| Select | Left-click |
| Box-select | Left-drag |
| Add/remove from selection | Shift + click / Shift + drag |
| Select all visible units of a type | Double-click a unit |
| Move / gather / attack / build-repair / farm | Right-click ground, resource, enemy, or own foundation |
| Attack-move | `A` then left-click, or Ctrl + right-click |
| Rally point | Select a building, right-click the ground |
| Control groups | Ctrl + 1–9 to set, 1–9 to recall (double-tap to center) |
| Town Center / idle villager | `H` / `.` |
| Camera | WASD / arrows / screen edge, mouse wheel zoom, middle-drag, minimap |
| Pause | Space |

The command panel (bottom right) shows the build menu for villagers, plus train/research buttons and
the production queue (click an item to cancel and get a refund) for buildings. **Delete** removes
selected units or buildings.

### Rules summary

- Resources: food, wood, gold, stone. Each side starts with a Town Center, 6 villagers, a Scout, and
  300 food, 300 wood, 150 gold, 100 stone. The Town Center houses 10, so all starting units fit.
- Villagers carry 10 resources at a time. Natural resources are finite. Deliveries only count at a
  compatible drop-off: Town Center (all), Granary (food), Storage Pit (wood/gold/stone).
- Buildings: Town Center, House, Granary, Storage Pit, Farm, Barracks, Archery Range, Stable,
  Blacksmith (Toolworking, Fletching, Scale Armor), Watch Tower, Wall.
- Units: Villager, Clubman, Scout, Swordsman, Spearman, Bowman, Skirmisher, Horse Archer, Cavalry,
  Centurion. They have counters (spearmen beat cavalry, skirmishers beat archers, and so on).
- **Conquest:** a side loses when it has no Town Center and no units. Other buildings don't keep it
  alive. A side that still has units keeps fighting after losing its Town Center.
- **Time limit:** each side scores the sum of (original food+wood+gold+stone cost × remaining HP
  fraction) over its surviving units and buildings. Equal scores are a draw.
- Both sides use identical rules, whether the orders come from a human or an LLM.

### Maps

There are 4 sizes (Small 96², Medium 128², Large 160², Huge 200²) and 5 biomes (Temperate
Grasslands, Desert Oasis, Snowy Highlands, Dense Woodland, Rocky Steppe). Every combination works.
Maps are generated deterministically from seed + size + biome + generation version, and are
point-symmetric so both sides get identical surroundings. AI vs AI setup previews the actual map.
Player vs AI setup shows only a biome style sample, so the real terrain and resources stay hidden.

## LLM commanders

Each AI side is consulted every *decision interval* of **simulated** time (default 15 s). It gets a
fog-of-war-filtered observation: resources, population, buildings and queues, every unit with its
current task, known enemy units and buildings, known resource clusters, recent events, the results
of its previous commands, and its own saved plan. It replies with JSON commands covering every order
category:

`explore`, `gather`, `build` (placement, including wall lines), `train`, `research`, `move`,
`attack` (target id or attack-move), `defend` (hold an area), `group` (named armies, addressed as
`group:<name>`), `stop`, `rally`.

The commands are resolved inside the deterministic simulation. Each reply is applied exactly
*response window* simulated seconds (default 10 s) after its observation. If a model hasn't answered
by then, the simulation waits at that tick boundary ("Waiting for …"). This is why 1×/2× speed and
model latency never change outcomes or decision timing. In Player vs AI, requests are only made for
the AI side, and the AI's reasoning is hidden from the human until the replay.

## Pause, speed, history review and replay

- **Pause** stops at a whole-tick boundary, even while a decision request is in flight. The reply is
  buffered and applied at its scheduled tick after you resume.
- **1× / 2×** only change how fast simulated time passes.
- **History review:** use the timeline (⏮, ⏪ 30s, slider, 30s ⏩) to rewind to any earlier moment
  and play it back at 1×/2×. **● Live** returns to the live match. Orders are disabled while reviewing.
- **Replay:** completed and imported matches open as replays. The recorded human orders appear as
  map markers and in an order log. Fog follows the selected perspective, AI logs follow the playback,
  and a checksum indicator confirms the replay matches the recording up to the final result.

In AI vs AI you can switch between **Split** (two independent cameras), **Left** (full-width left
view) and **Right** (full-width right view). Each view can show **Omniscient**, **left AI
knowledge** or **right AI knowledge**.

## Persistence, export and import

- Every match (configuration, command log, AI decisions, checksums, result and the latest state
  snapshot) is stored in SQLite. The app autosaves about every 15 s, and also on pause, finish and
  exit. Saved matches are listed on the home screen and can be resumed or replayed after a restart.
- **Export** (in game or from the list) downloads a versioned JSON file (`format: "ai-empires-match"`,
  `formatVersion: 1`) for completed, paused or running matches. It holds everything needed for exact
  playback: config (with generation and rules versions), every human and AI command with its tick,
  AI decisions (thoughts, plans, raw replies), periodic state checksums and the result. API keys are
  removed.
- **Import** validates the whole file first: every field, enum, range and command schema; tick
  ordering; and who issued each command (AI commands only for AI slots, human commands only for the
  human slot). It then re-simulates the full match and checks every checksum and the final result.
  Malformed or tampered files are rejected with a list of errors. An imported running or paused
  match can be resumed, but it needs its API key again if the endpoint requires one.

## Project layout

```
src/shared/        deterministic game core (runs in browser and Node)
  rules.ts         units, buildings, techs, costs, constants
  mapgen.ts        seeded, symmetric map generator (5 biomes × 4 sizes)
  sim.ts           simulation: economy, construction, combat, pathing, fog, victory, scoring
  pathfind.ts      weighted A* on the tile grid
  engine.ts        command-log driven engine, snapshots, checksums, replay verification
  controller.ts    LLM decision scheduling in simulation time (stall-at-tick semantics)
  record.ts        export format and strict import validation
  serialize.ts     state snapshots and hashing
  ai/              observation builder, prompt + reply parser, command resolver, scripted mock
src/server/        HTTP API, SQLite store, OpenAI-compatible client, built-in mock endpoint
src/client/        Three.js renderer, procedural models, input, HUD, screens
tests/             vitest acceptance tests
scripts/           headless runners and browser (playwright) checks used during development
tools/             model gallery page for inspecting every unit/building model
```

## Tests

```bash
npm test             # rules, maps, determinism, pacing, pause, replay, import validation
npm run typecheck
```

`npx tsx scripts/run.ts Medium DesertOasis myseed 60` plays a full headless AI-vs-AI match with
the scripted commander and prints progress.
