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
- **−2 and −3, the subway.** Two lines that cross: one running north–south at
  `SUBWAY_LEVEL`, one east–west at `SUBWAY_DEEP`. Each is a running tunnel
  under a road with a concourse (`HALL_LONG` × `HALL_WIDE`) on every other
  cross avenue. Concourses are furnished from `City.fittings` — ticket
  offices, shops, food counters, benches, maps and columns — and each has two
  ramps up to the street. Subway lines are ordinary `Skytrain`s with a
  negative `level`, so they reuse the dwell/reverse/boarding machinery
  unchanged.

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

## Underground walls

Where a hollow meets the earth, a wall stands up from the floor along the
shared edge. Which edge that is depends on the neighbour: `-x` is the tile
diamond's **upper left** edge, `-y` its upper right, `+x` its lower right,
`+y` its lower left. Naming the wrong pair of corners puts every panel one
corner round, which along a straight boundary comes out as a sawtooth -- and
worse, lands the `-x` wall on the same edge as the `+y` one, so the boundary
that should carry it is left bare.

## Cars in a garage

Every car in one garage faces the same way. That is not only how a car park
looks, it makes keeping them apart a matter of two distances -- a car's
length along that facing, its width across it -- instead of a general
box-overlap test. A candidate bay is rejected if it is within both of an
existing one. Placement is by rejection rather than a fixed grid, so a
garage takes as many cars as its shape allows and no more.

## Vehicle headroom

A car parked in a basement garage has the street's slab a storey over its
roof, so anything taller than that pokes through. Each model in `CAR_MODELS`
gets a `vfit`: measure its highest point, roof furniture included, and if that
overruns 95% of a storey, scale it to fit. `drawCar` applies `vfit` inside
`px()`, so every height in the body -- hull, canopy, light bar, fin, cargo box,
thrusters -- is squashed as one piece rather than clipped somewhere in the
middle.

## Stub roads and their junctions

A stub road runs from an avenue out to a roundabout of its own. It has to
reach the avenue's carriageway: the avenue lays a kerb down each of its
flanks, and a stub that stops on the near side of that kerb leaves itself
and its roundabout an island no car in the sector can reach.

Two things follow from that kerb, and both were wrong:

- The clear-area test for an eastward or southward stub started **on** the
  kerb, which is never open ground, so those two directions could never
  place at all. It starts beyond the kerb now -- the stub is going to pave
  over that tile anyway.
- The westward and northward stubs stopped one tile short of the kerb.
  They now pave through it and touch the avenue lane.

Once the tiles touch, the existing tee pass does the rest: a junction tile
on the avenue has four road neighbours, which is what that pass looks for
before opening turning exits. The mouth of each stub is given a zebra so
the tee reads as a junction rather than two roads that happen to meet.

If a change here ever needs checking, the measure is simple: flood the road
network from the avenues and count what is left over. It should be nothing.

## What the cut plane hides

A level above ground shows once the plane is at or over it. A level below
ground has a floor over its head as well -- the street's slab, or the level
above it -- and stays hidden until the plane has cut that away. So a section
taken at street level shows the street, not the garages beneath it, and a
subway train is invisible from above ground. `shown()` carries both rules;
anything drawn underground must go through it, trains included.

## Driving routes

`drivePath` is always lane-legal. Where the one-way network cannot reach the
tile asked for, the car is routed to the nearest tile it can reach. It used
to fall back to a search that ignored lane direction entirely, which handed
the player routes running the wrong way down a one-way street for a hundred
tiles at a stretch -- 5 to 10% of all routes.

Measuring lane discipline from car positions needs care: a car carries its
previous heading through the first half of a corner tile and only commits to
the new tile's lane at its centre. Sampling without allowing for that reports
around a fifth of ring traffic as driving the wrong way when none of it is.

## Being out of sight

An agent obeys the cut plane like everything else, and the ghost pass draws
the squad over the top of the frame at low alpha whatever the plane is doing.
Together that gives one rule: solid where you are looking at the level they
are standing on, transparent everywhere else -- two levels down, two levels
up, or behind a building. Measured as pixel shift against a frame with the
squad moved away, an agent on their own level reads at around 220 and a
ghosted one at around 70.

## Roundabouts

`City.ring` marks a roundabout's circulating lane. A ring always offers a way
round, so a car that keeps choosing it will circulate for ever -- one was
measured going round for forty seconds. After half a lap a car takes the next
exit it is offered whatever else is available, which bounds circulation at
about fifteen tiles.

Measuring this by time on a ring is misleading: a car held in a queue there
is not circulating. Count tiles entered instead.

## Driving into a garage

A garage ramp is a run of tiles stepping down from the carriageway to the
basement floor, one surface each, joined end to end by `LINK_RAMP`. A single
link straight from the road to the basement -- which is what it used to be --
is something a person can take and a car cannot: there is nothing under the
car on the way down. Heights step in eighths of a storey, which keeps every
one of them exact in a `Float32Array`.

`Pathfinder.carPath` drives on the level model: the carriageway keeps its
one-way lanes, a garage floor and its ramp are open in every direction, and
the two are joined only by `LINK_RAMP` -- a car will not take a staircase.
`cmdMove` uses it when either end of the trip is below ground and the flat
road search otherwise, which is cheaper and holds the lane better.

Two things follow from a car changing level and are easy to miss. Its riders
have to take its height with it, or a squad that drives down a ramp is left
standing on the street and steps out a storey above the floor. And the cut
plane hides the car along with everything else underground, so the player's
own car joins the ghost pass -- otherwise driving into a garage makes it
vanish.

When testing a ramp, aim at its own mouth. Routing from a garage to some tile
clear across a one-way city tests the search budget, not the ramp, and will
report failures that have nothing to do with it.

## The metro

A concourse reaches ten tiles along the line and five either side of it, and
its floor stands `TRACK_DROP` above the track it serves, so the trench reads
as a trench rather than the train sitting on the platform. A subway rides the
floor of that trench; everything else -- boarding, the cut plane, the station
record -- still gates on the platform level, because a train a third of a
storey below the platform would otherwise be out of reach of anyone standing
on it.

Access is by ramp, two per station, **one for each platform**. The track
trench splits the concourse in two and there is no crossing it except along
the rails, so a ramp is placed for the left-hand kerb and another for the
right-hand one, each taking whichever end of the hall it can reach. Placing
them by end instead - one at each far end, first kerb that fits - left seven
of sixteen platform sides with no way out at all.

For the same reason the bends turn *away* from the track. An L or a U folded
towards the middle of the hall walks straight into the trench, and the tile it
lands on is at track height, not platform height, so the ramp ends on the
rails. Any step whose offset crosses the centre line is rejected outright.

A ramp gains a storey every two tiles, so reaching a platform two storeys down
takes four and the deeper line six; it is laid straight along the kerb where
there is room and folded into an L or a U where there is not. Its mouth is an
opening in the pavement with a rail round three sides and the roundel on a
post, which is what makes it findable from across the street.

Ramps are `LINK_ESCALATOR` and garage ramps are `LINK_RAMP`: people take
either, cars only the second, and `layOutStairs` skips both -- a ramp drawn
as a switchback staircase is not a ramp. Anything counting ways underground
has to look at the link kind, and anything tracing one has to follow the
whole chain: a ramp reaches its depth over as many links as it has steps,
not one.

## The tapped-destination marker

The marker holds until everyone ordered there has arrived, rather than fading
on a fixed timer, so it answers "have they got there yet" and not just "the tap
registered". It watches the movers themselves -- the agents' paths, or the
path of the car they are riding in -- and starts fading only once the last of
them stops. A fresh order removes the previous marker: it is no longer waiting
on anybody, and leaving it up would pin a ring to a destination nobody is going
to. Every marker is up for a minimum first, so a refused one still reads.

The shockwave runs on its own repeating clock rather than on the remaining
life, or a held marker would freeze into a decal instead of pulsing.

## Cutting the section to something you tapped

Tapping an agent's portrait drops the section plane onto the storey that agent
is standing on. The storey that *shows* a height is the one it reaches up into
-- its ceiling, not its floor -- so the plane wants `ceil(z)`, not `round(z)`:
an agent on a skytrain platform at 2.125 needs the plane at 3, and one on a
garage ramp at -0.5 needs it at 0. Underground the same expression already
lands right, because a level below the street is only shown by the plane that
took the slab over its head away: -2 for the first line, -3 for the second.
Clamp it to the slider's own range and the tap can never put the plane
somewhere the slider cannot get back from.

## Friendly fire

Every weapon but one fires a projectile, and projectiles have always skipped
the shooter's own team. The laser is hitscan -- it walks a beam out to its
range and damages everyone it passes through -- and it was checking only
whether a ped *was* the shooter, not whose side they were on. A squad strung
out in a line had one agent cutting down the other three: measured at full
health each, the three behind the muzzle went to nought. They take nothing now,
and the target at the far end still dies.

Gauss is not the same case and is left alone: it is a blast, and a blast that
spared your own side would be a different weapon.

## Who runs and who does not

Police never flee. Gunfire and deaths already only alerted civilians, but the
traffic dodge did not make that distinction: an officer who had jumped clear of
a car was left in the flee state for good, sprinting at the dodge pace forever,
because `followPath` only ever clears the state back to idle from "walk". So
the dodge now puts civilians into flee and everyone else into a walk, `speed`
is handed back when the dodge cooldown runs out, and `startFlee` refuses a cop
outright. Measured: nought flee-frames through a shooting, a killing beside
them and a car driven through them, against 69 before, and their pace comes
back to the 2.9 they spawned with rather than sticking at the 4.6 sprint.

Rival agents deploy as fire teams. Thirty lone gunmen scattered across the
sector read as thirty accidents; the roster is broken into threes and fours
(the sizes chosen so the last team is never left short) and each team set down
together. They also hold together afterwards: each one wanders about its team's
patch rather than about wherever the last wander left it, or thirty random
walks pull the teams apart inside a minute. Eight groups per sector, and they
are still eight twenty seconds later.

## Getting out of the way of traffic

The ordinary flee runs directly away from whatever caused it. For a car in the
road that means running down the road in front of it, keeping pace with the
bumper until it catches up -- which is why civilians looked like they were
failing to react when they were reacting exactly as told. What saves someone is
a step to the *side*, so a pedestrian with a car bearing down picks a square
across its line, on whichever side they are already nearer, and sprints for it;
if that way is a wall they try the other.

The look-ahead scales with the car's speed, so the warning is a fixed amount of
time rather than a fixed distance. Driving a car at speed 9 down a line of
twelve people standing on its route used to kill six of them; it now kills one
or two -- the ones already under the bumper when the car pulls away, who never
had a warning to get. Running people down is still perfectly possible, which is
the point: a pedestrian gets a chance, not immunity.

Three conditions narrow it to people who are genuinely about to be hit. It is
the squad's own car only -- traffic yields to anyone in front of it, so an NPC
car is never actually about to hit anybody, and having the pavement scatter
whenever a taxi went past was the first version's real fault. They have to be
standing in the carriageway: someone on the kerb is not about to be hit however
close the car passes. And the corridor is 0.85 tiles either side of the car's
line rather than 1.5 -- barely wider than the 0.6 it actually runs people down
in. Ten of ten bystanders on the pavement used to jump for a car going past;
none now does so while off the road.

Telling a dodge from an ordinary panic, in a test or in the code, is `dodgeT`:
the dodge sets it, `startFlee` leaves it at zero. Worth knowing, because a
death in the street sets everyone within ten tiles running, and one of those
can quite properly end up in the road and dodge for real.

## Drawing a hole in the ground

A garage ramp that works is not a garage ramp that shows. The run of surfaces
the car drives down lives entirely under the street, and `shown()` hides
everything under the street from the surface view, so the car simply sank
through the pavement and vanished. `City.garageRamps` records each run so the
renderer can cut it open.

Two pieces, one per tile of the run and each in its own depth bucket, so a car
part-way down is drawn between the tile it is on and the tile in front of it:

- **Out in the open**, a trench: a deck sloping from the near edge of the tile
  to the far one, walls down either side, chevrons, and the rim of the cut
  stroked into the pavement.
- **Where it goes under the building**, a portal: a dark opening in the base of
  the wall it passes through, with a lintel, a hazard stripe and a light over
  the door.

Both are clipped, and the clip is the whole trick. A hole shows only what fits
inside its own opening -- a sight line grazing the near rim is the lowest thing
the eye can reach, and anything the deck projects below that rim is behind the
pavement in front of it. Drawn unclipped the trench reads as a slab piled on
the road rather than a cut into it, because the sunk deck spills downscreen
over ground that should be in front of it. The trench clips to its own rim; the
portal clips to the half-plane above the rim of the tile in front, or the
opening spreads out across the pavement as a black wedge.

The run leaves the carriageway at right angles to it and goes straight in. It
used to dog-leg -- all the way along x, then all the way along y -- which put a
kink in the middle of the trench and had cars turning off the road on the
diagonal. Now the mouth is a road tile, the first step is off the road, and the
direction never changes; since both are axis-aligned, crossing the kerb in a
straight line *is* crossing it square. Three tiles is the shortest run allowed,
because that is what keeps every step under half a storey.

A mouth is never put on a pedestrian crossing, nor on the tile either side of
one along the carriageway: a garage that opens onto a zebra has cars turning
off the ramp straight through people on foot. This is a hard reject rather
than a preference, and it costs nothing - about half the mouths were landing
on a zebra, because the search likes the corner of the block and that is
exactly where the crossings are painted, and every garage still finds a mouth
somewhere else along the same kerb.

A portal is only worth drawing on a face the camera can see -- the two whose
outward normals point at the eye. So the mouth search scores its candidates: an
entrance that will face front beats a nearer one, and a run that would be dug
through a lamp post loses to one that would not. About three quarters end up
facing front; the rest have no road on their south or east side to leave from,
so they open on a face this projection never shows and their trench slides
under the building as it should. A few more are simply behind a taller block,
the same way anything at street level is. Straightening the run cost some of
that -- the dog-leg could reach around a corner to a better face -- and it is
the right trade: a ramp that reads wrong from every angle is worse than one
whose door faces away.

Seen from the garage the ramp is drawn differently: there is no street left to
cut into and nothing in front to hide behind, so it becomes a deck on skirts
running down out of the ceiling, unclipped, with the portal tile and everything
past it drawn as deck too. Those tiles are skipped from the street view because
a wall is in front of them -- but leaving them out of the garage view stopped
the ramp a tile short of the floor it serves.

One exception to `shown()` goes with this: something part-way down an open
trench is in plain sight, not in a basement, so a car or an agent between 0 and
-1 on a trench tile stays drawn solid. Below -1 it is inside, and hidden again.

## Two lines, two depths

One line is a shuttle, not a network, so the metro always runs a second one
across the first. The two cannot share a depth: at the crossing the trains
would drive through each other, and the second line's concourse would find
every tile of the first already spoken for and leave holes in its own tunnel.
So the second line is bored a storey deeper, and the crossing tile carries
three floors -- the street at 0, the shallow track at -2.375, the deep one at
-3.375.

That means nothing underground may be keyed by tile alone. `underSurf` is
keyed by tile *and* storey (`uk()`), because a garage at -1, one tunnel at -2
and another at -3 legitimately pass through the same tile. The same goes for
tests: a probe that counts floors at exactly -2, or reads a track at exactly
-2.375, sees one line and misses the other. Read the depth off the line or
the station and measure relative to that.

A ramp's length follows its depth -- two tiles a storey, so four tiles to the
shallow line and six to the deep one -- which is why the straight, L and U
shapes are laid out from `RUN` rather than written out.

Not built yet: the two concourses do not connect to each other where they
cross. Changing lines means going up to the street and back down.

## The armory, in two columns

The loadout and the market used to be stacked as two rows across the top of
the screen, which left the bottom two thirds empty and squeezed nine market
cards into one strip. They sit side by side now, each column filling the
height between the agent tabs and the action bar: eight loadout slots two
across, nine market cards three across. Every cell roughly doubled -- 45x31 to
133x65 for a slot, 90x40 to 123x87 for a card -- which is what buys room for
the item's name under the icon in the loadout, where before there was only an
icon and a charge bar.

The action bar stays pinned to the bottom by `margin-top:auto` and is still
where every purchase, reload and sale happens; the columns are the thing that
grows, so the buttons never move as the grid changes. Both columns keep a
`min-height` on their cells so the three test sizes -- 667x375, 850x390 and
1024x460 -- all still fit without scrolling.

## Signage

Four pools, each four times the size it was: 32 video wall designs across
eight animated layouts, 32 neon signs across four shapes, 32 billboards
across eight layouts, and 96 shopfronts from six sign styles by four window
treatments by the names and colours. On top of those, six advertisement
walls three storeys tall and two wide, animated over six frames -- rare
enough that a sector carries about three.

A pool being four times the size does not put four times as many designs on
screen: a sector only ever places forty to sixty of each of the upper-storey
kinds, so the count you can observe is bounded by that, not by the pool.
Shopfronts are the exception -- there are eighteen hundred of them, and all
96 designs show up.
