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

A fire escape is half a tile deep and two tiles long, laid along the wall it
serves. Two flights, each half the depth, run the full length side by side
and offset from one another by that half tile; a landing spanning both caps
each flight so an agent can turn the corner onto the next. The pieces are
painted back to front within the entity, because the two flights sit at
different distances from the camera.

The second tile of that footprint is chosen during generation, in
`layOutStairs`, and stored on `City.stairRuns`; the renderer only reads it.
It has to be there rather than in the renderer, because where a lamp post or
a street tree stands in the way the furniture is moved aside -- the stair has
to be where it is, the tree only wants to be. Nothing falls back to a single
steep tile: every stair gets its two tiles. If a displaced lamp has nowhere
within three tiles to go it is removed outright, though no seed has yet
needed that. The whole two-tile run is what makes the pitch walkable: over
one tile a flight climbs a storey at about 1.4 storeys per tile, over two at
0.64.

Two traps that pass live in there. Every stair's own foot tile is reserved
before anything moves, or a lamp shifted out of one flight's way lands under
another's. And a subway entrance can sit directly over its own landing, so
the two ends of the link share a tile and there is no direction to read off
them -- such a stair is faced into the concourse instead, by the first
compass direction with both a tile ahead and a tile beside it to build on.
Before that, those stairs drew with a zero direction vector, which collapsed
the whole flight to a point.

Decks are drawn as extruded boxes, not bare quads. A flat quad has no
thickness to show, so from any angle that reveals its underside the whole
flight reads as a sheet of card. Each deck paints a skirt down its four
edges before its top face, far edges first so the near ones -- the visible
ones -- land on top. Stanchions are box sections with a lit face and a
shaded one, and they stand on the outboard side only: the wall side is
bolted to the building.

Every stair in the level model is drawn this way, not just fire escapes:
station steps, subway entrances and garage ramps share the routine. A garage
ramp may reach several tiles to find its road mouth, so the drawing takes a
single step toward the far end rather than the whole offset -- otherwise the
footprint scales with the distance to the mouth.

## Working at a level other than the street

Two things have to follow the height, not just the plan position:

- **The tap marker.** `Ping` carries a `z`, taken from the surface that was
  tapped, and draws lifted by it. Tap a roof and the marker lands on the
  roof; tap a concourse with the section down at -2 and it lands on the
  concourse.
- **The follow camera.** It corrects the focus point for the subject's
  height so a raised squad stays centred. That correction used to be
  guarded on `fz > 0`, which left a squad in a garage or a concourse
  sitting a storey or two below centre. It now applies in both directions.

`SYND.worldToScreen(x, y, h)` is the inverse of `screenToWorld` and is what
tests should use to aim a tap at a particular tile and height. Both work off
`cam` directly, which is correct: the height correction is already baked
into `cam` by the follow code, not applied separately at draw time.

## Stairs under the section plane

A stair is clipped like a building. Flights above the plane are dropped;
the flight the plane passes through is truncated where it crosses, and the
exposed cross-section is painted black, as a sliced wall is. Stanchions
stop at the plane with a black cap, and a railing -- which stands proud of
its deck and so meets the plane before the deck does -- is cut back
separately.

The same clamp fixes a separate bug: a flight is drawn per whole storey, so
a station stair, which climbs 2.125 storeys to reach its platform, used to
draw a full extra flight past the top. Flights now stop at whichever comes
first, the top of the stair or the cut.

Stairs used to be dropped wholesale whenever the section sat at or below
street level, which is why nothing underground appeared to have any. They
are clipped now instead, so a subway entrance shows the part of itself
below the plane.

## Stations and trains

A skytrain line follows an avenue. `trackCentre(line)` is the one place that
says where its track runs across that avenue: a viaduct sits over the first
lane, a subway tunnel is bored under the middle. Everything that has to agree
on where a train actually is -- the renderer, `trainPos`, the tap hit test --
reads it, because the two kinds of line do not share an offset and hardcoding
either one puts the other train inside the earth.

The platform is ten tiles along the track and two across it, on the lane
beside the viaduct. It is drawn one tile at a time, each in its own depth
bucket: as a single entity a ten-tile slab lands in one bucket, and a train
alongside it then sorts in front of the whole platform or behind the whole
platform rather than interleaving with it. That is what made trains look
wrong at stations -- along with the train being drawn down the platform's
own column instead of over its track.

Its track edge carries a painted line rather than a railing, so nothing
stands between the squad and the train they are about to board.

A train's `u` is the middle of its set, not its nose, and the renderer places
cars either side of that. Anchoring on the nose meant every car flipped to the
far side of it the instant the line reversed -- the whole train jumping its own
length at the terminus, which is a station. It also left the set trailing off
one end of the platform; centred, it stops where the doors would be.

It brakes along `sqrt(2*a*left)`, the fastest it could be going and still come
to rest exactly at the platform. A fixed minimum approach speed instead left it
crawling the last stretch at a constant rate and then stopping dead.

A tap is hit-tested against the train's body as a solid object, at the
track's height and again a little above it so tapping a car's roof counts.
Tap the train to board, tap anywhere else to get off, and tapping the train
you are already riding does nothing.

Anything measuring a station in a test needs a search radius that matches the
platform, not the old five-tile one; and converting a train's position to a
tile takes `Math.floor`, not `Math.round` -- a track centre sits at x.5.

## Acknowledging a tap on a vehicle

Tapping a car or a train to board it lights the vehicle up for half a second:
blue when the order took, red when nothing could act on it. Without that, a
tap that fails -- the wrong side of the platform, no way through to the car,
a train still moving -- looks exactly like a tap that missed the vehicle
altogether.

Every panel a vehicle draws goes through its own local `quad`, so the flash
is built by accumulating those same paths into a `Path2D` and filling it once
with `globalCompositeOperation = "lighter"`. That gives the exact silhouette
with no second body model to keep in step with the first -- which matters for
the car, whose hull is lofted from twenty-segment rings rather than described
by any polygon you could write down.

Two things to keep in mind if this is ever tuned. The envelope is a single
decay from full brightness; an oscillating one reads as a flicker over so
short a life. And measuring it from pixels needs the lit frame bracketed
between two unlit ones, because the city behind it never stops animating.

## Walking a staircase

`stairWalk(run)` returns the line an agent follows up a flight: along one
flight to its head, across the landing there, back along the next. It has to
match what `drawFireStair` paints, so the two share their INSET, LAND and
half-tile v-offsets; change one and the other walks through the air beside
its own staircase.

`climbPath` expands every step that crosses a stair link into that line, and
marks those waypoints. A marked waypoint is walked at `STAIR_PACE` of open
ground speed rather than being paced by its climb: the path already traces
the flights, so the rise is no longer something to compensate for. It also
gets a much tighter arrival radius -- stair waypoints come every half tile or
so, and the ordinary one hands back enough of each segment to make the climb
measurably faster than the pace asks for.

## Vehicle headroom

A car parked in a basement garage has the street's slab a storey over its
roof, so anything taller than that pokes through. Each model in `CAR_MODELS`
gets a `vfit`: measure its highest point, roof furniture included, and if that
overruns 95% of a storey, scale it to fit. `drawCar` applies `vfit` inside
`px()`, so every height in the body -- hull, canopy, light bar, fin, cargo box,
thrusters -- is squashed as one piece rather than clipped somewhere in the
middle.
