# SYND

A mobile-first, browser-based squad tactics game in the style of Bullfrog's
**Syndicate** (1993) and its expansion **American Revolt**. Command up to four
cyborg agents in a procedurally generated, neon-drenched cyberpunk metropolis.

Everything is generated in code at load time: the 512×512 city grid, the pixel
sprite sheets (30 civilian designs + police + rival agents, each with 8-direction
walk / flee / die animations), the animated ad videowalls, the neon signs, and
all audio (Web Audio synthesis — no asset files at all).

## Play

Serve the repo root over HTTP (or open the GitHub Pages deployment) on a phone
in **landscape** or on desktop. The game is an installable PWA and works
offline after the first load.

- **Left panel (1/5 of the screen)** — top to bottom:
  - **Agent dolls**: tap a doll to select that agent alone; tap the central
    **S** emblem to select the whole squad. Health (and shield) bars live here.
  - **Inventory**: 8 slots for the selected agent. Tap to select an item
    (highlighted orange); every weapon shows its remaining charge as a bar —
    an empty weapon is useless. Tapping a **medkit** heals; tapping the
    **shield belt** toggles it. **Drag a slot into the world** to have the
    agent walk there and drop the item.
  - **Minimap**: the surrounding area. The current objective is the white dot
    with radar pings.
  - **WALK / SHOOT** toggles (mutually exclusive):
    - **WALK** — tap the viewport and the selected agents path there. Tap a
      dropped item to collect it, tap a stopped, pilotless car to board it.
    - **SHOOT** — tap to fire in that direction; agents keep walking while
      firing, and auto-engage hostiles that come into range.
- **Cars**: shoot a passing car to force it to stop — its pilot bails out and
  flees. Board it with your squad, then tap anywhere on the road network to
  drive there. Dead-end streets always end in a roundabout so you can come
  back on the opposite lane.
- **Weather**: each mission rolls day / night / rainy day / rainy night.

## Objectives (one per mission, at random)

| Objective | Description |
|---|---|
| **Assassinate** | Kill a marked target across the city. Police shoot on sight. |
| **Persuade** | Reach the target, use the **Persuadertron** nearby, then escort them to the extraction zone while rival agents pour in from off-screen. |
| **Escort** | Reach a VIP on the far side of the map and bring them back to the insertion point under attack. |
| **Purge sector** | 30 rival syndicate agents are hunting you. Kill them all. |

## Campaign

Progress persists in `localStorage`: your agents, their gear, credits and the
mission counter. Cops usually drop a gun (occasionally better); rival agents
drop from the full arsenal: gun, uzi, shotgun, minigun, laser, gauss gun,
shield belt, medkit, persuadertron. Between missions the **Armory** sells all
of it and lets you hire replacements for fallen agents. Losing the whole squad
(with no funds for a recruit) ends the campaign.

## Development

```bash
npm install
npm run build      # bundle to dist/synd.js (committed, so Pages serves it)
npm run typecheck
npm run serve      # dev server with watch
```

`index.html?seed=42&kind=assassinate&weather=night` forces a deterministic
mission (kinds: `assassinate | persuade | escort | killall`; weather:
`day | night | rainday | rainnight`).

The stack is plain TypeScript + HTML5 canvas, bundled with esbuild. No runtime
dependencies.
