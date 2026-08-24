# Levels

The sector is three-dimensional. Heights are in **storeys**; the street is 0,
roofs are positive, anything dug out is negative. `STORY_H` px on screen is one
storey, and one storey costs exactly what one tile of ground costs for weapon
range and accuracy.

## The model

`City.levels` is the single source of truth for where anything can stand. It is
a flat, allocation-free structure built once during generation:

```
start[]      per tile, the range of its surfaces in z/kind/tile
z[]          surface height in storeys, may be negative
kind[]       SURF_GROUND | SURF_ROOF | SURF_PLATFORM | SURF_TUNNEL | SURF_BASEMENT
tile[]       which tile each surface belongs to
linkStart[]  per surface, the range of its links in linkTo/linkKind/linkCost
linkTo[]     the surface at the other end
linkKind[]   LINK_STAIR | LINK_LADDER | LINK_ESCALATOR
linkCost[]   what the search pays to use it
```

A tile carries **as many surfaces as it needs**: a pavement at 0, a basement at
-1, a metro platform at -3 and a roof at 5 can all belong to the same tile. Two
surfaces are only walkable neighbours when they are on adjacent tiles at the
same height; anything else needs a link. Links are stored both ways.

Read it through the helpers in `citygen.ts` - `tileSurfaces`, `surfaceNear`,
`surfaceUnder`, `hollowAt` - rather than touching the arrays directly.

## Adding content underground

Everything below already works, so new content is generation only:

1. In `generateCity`, after the surface pass, `lb.add(tile, z, kind)` each floor
   tile of the new structure and keep the returned indices.
2. `lb.link(a, b, LINK_*, cost)` wherever a stair, ladder or shaft joins two
   surfaces. Cost should scale with the climb - the existing stairs use
   `1 + height * 1.5`.
3. Pick depths that are **exact in float32** (halves and quarters: -1.5, -2.25,
   -3). Heights are compared for equality when deciding whether two surfaces
   are walkable neighbours, and a value like `-64/30` will not survive the
   round trip through `Float32Array`.

That is all. The pathfinder sizes itself to the surface count, the section
slider finds its own floor from the lowest surface, the renderer cuts the earth
wherever the plane is below the street, and shots are blocked by earth unless
`hollowAt` says the sector has really been dug out at that depth.

## What is not built

The service tunnel under one avenue is a **proof**, not content: it exists so
every layer is exercised. Still to do:

- **Metro**: tunnels under the avenues with platforms and trains. The train,
  station, dwell and boarding machinery in `world.ts` is level-agnostic already
  - a metro is the same `Train` on a line whose stops sit at a negative height.
- **Sewers**: a connected maze on its own level, reached by manholes. Needs a
  generator; nothing else.
- **Basements**: rooms under buildings with internal stairs. Note a basement
  under a building means the building tile carries a surface at a negative
  height while remaining solid at street level - the model allows it, but
  `losShot3` treats a building as solid from its footprint upward, so a
  basement wall will need its own rule.

## Known gaps

- **NPCs stay on the street.** Civilians, police and rival agents path with the
  two-dimensional `walkPath` and never take a link. Sending them underground
  means routing them through `climbPath` and teaching target selection to
  weigh a target on another level.
- **Nothing renders below the plane except floors.** Tunnel walls, ceilings and
  fittings are not drawn; a sublevel currently reads as a lit floor cut through
  black earth.
- **The section plane is integer.** Surfaces at fractional depths show when the
  plane reaches the integer below them.
- **The model is frozen after generation.** `City.levels` is packed once and
  never rebuilt, so editing `tiles` or `height` at runtime does not add or
  remove a surface. Anything that reshapes terrain mid-mission - a demolished
  building, a collapsed floor - needs the builder run again, or an incremental
  update path that does not exist yet.

## What lives underground today

- **−1, basement garages.** One per building lot of 12 tiles or more, roughly
  two lots in five. Each has a ramp linking a `SURF_BASEMENT` tile to a road
  tile within four tiles of the lot, so every garage is reachable by car and
  on foot. Parked cars carry `Car.z = GARAGE_LEVEL`.
- **−2, the subway.** A running tunnel under a road, with a concourse
  (`HALL_LONG` × `HALL_WIDE`) on every other cross avenue. Concourses are
  furnished from `City.fittings` — ticket offices, shops, food counters,
  benches, maps and columns — and each has two stairs up to the street.
  Subway lines are ordinary `Skytrain`s with `level: SUBWAY_LEVEL`, so they
  reuse the dwell/reverse/boarding machinery unchanged.

## Testing against the level model

Tests must read `city.levels`, not the old `structZ` / `stairTo` arrays,
which no longer exist on `City`. Two traps that have already bitten:

- A stair check that hardcodes `2.125` only ever finds skytrain platforms.
  Use the line's own `level`, and remember a subway concourse is wider than
  a platform, so the search radius has to grow with it.
- Any check that compares two entities by `x`/`y` alone will now see a car
  in a garage as overlapping the car on the street above it. Compare `z`
  first.

## Occlusion and height

A building is sliced open only when it genuinely stands between the camera
and an agent. The test works in world space: the view ray out of a point
travels one tile nearer the camera for every `TILE_H` it climbs, so a column
hides the agent only if it out-tops that ray where the ray crosses its
footprint. Comparing screen positions by whole-tile depth buckets instead
mis-fires at tile boundaries -- an agent standing near the far corner of its
tile reads as being behind the column in the next bucket, which is how a
building used to dissolve under a squad standing on its own roof.

`Renderer.cutawayCount` reports how many buildings the last frame sliced
open, which makes this testable without reading pixels.

## Fire escapes

A fire escape occupies the whole of the ground tile it stands on. Two
flights, each half a tile wide, run the tile's length side by side, offset
from one another by that same half tile; a landing spanning both caps each
flight so an agent can turn the corner onto the next. The pieces are painted
back to front within the entity, because the two flights sit at different
distances from the camera.
