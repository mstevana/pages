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

## Mission shapes

Four more, chosen because each uses something the engine has and the older
missions ignore, and because each asks a different verb of the player. All four
run the length of a sector like the originals: the trek is the setup, the
objective is the payoff.

- **SEIZE THE CASE.** A courier walks a data case across the sector under a
  three-man guard. Kill him or turn him and the case falls where he stood; any
  agent picks it up and walks it to the extraction zone. It is the only mission
  carrying something you can lose - an agent who dies drops it, and it can be
  picked up again by anyone, including off the pavement where he fell.
- **BURN THE MOTOR POOL.** Six marked vehicles, two of them parked in basement
  garages. Wrecking the first one warns the rest, and every marked car still on
  the street is driven out of the sector - so the order you take them in is the
  whole tactical question. The two underground ones have no driver and will
  wait for you, which makes them the safe money and the street ones the ones
  under the clock.
- **HOLD THE UPLINK.** A pad to stand on while a transmission runs. Waves come
  at the pad rather than at the camera.
- **INTERCEPT.** A defector crossing the sector on his way out. Kill him or
  turn him before he reaches the boundary.

Three things learned building them.

**Diegetic pressure needs room to run.** The quarry in both SEIZE and INTERCEPT
bolts for a map edge when he sees the squad, and the first version sent him to
the *nearest* one. That is a thirty-tile sprint - ten seconds, uncatchable on
foot, and decided before the player can react. It is a coin toss, not a chase.
The exit is now the far edge, a hundred and fifty tiles or more, which is a
minute of running: long enough to close on him, cut a corner, or go and find a
car. He moves at 2.8 against an agent's 3.1, so a foot chase gains slowly and a
car settles it.

**What starts the clock should be the player's own mistake.** He does not run
on a timer; he runs when he sees you, and seeing needs line of sight. Coming at
him through the back streets gets you close enough to shoot, or even close
enough for the Persuadertron's three tiles. Walking up the avenue does not.

**A window has to be longer than what it asks for.** The uplink first ran for
exactly the hold it required, which meant a single second spent off the pad put
full pay permanently out of reach - a mission you can only lose, slowly, from
the first shove. The transmission now runs 210 seconds and asks for 150 of
them, so being pushed off costs the seconds it costs and nothing more. The
crowd on the pad is capped as well: two dozen rivals standing on it is not
difficult, it is finished. Capped at six nearby it is a sustained fight, and
measured peaks sit at five to seven.

## The rescue, in two halves

ESCORT and PERSUADE are the two rescues. Rivals contest the sector from the
first minute - they are not reacting to us, they were already here - but there
are only twenty-four of them and then no more. An endless stream is not
difficulty, it is a treadmill: no way to play it well, no reason to fight
rather than run, and no moment where you have won.

The pool is spent as they are *killed*, not as the clock runs: another pair is
sent only when fewer than four are on the board. On a plain timer the whole
roster arrived inside the first minute and the walk home - the half of the
mission that is meant to be hard - was deserted. Draining by attrition spreads
them over the whole job and makes avoiding a fight a decision: a squad that
walks past trouble reaches the target with ten to sixteen still in the pool,
and every one of those is waiting on the way back.

The escortee keeps up while any agent is within a block of him, and stops to
wait when the squad gets further away than that. A block is measured off the
city's own avenue spacing - it works out at twenty-six or twenty-seven tiles.
It is deliberately a cheat: a true line-of-sight test is honest and horrible to
play against, because he stops behind every parked lorry. Whoever is nearest
counts rather than the man he was told to follow, so splitting the squad does
not strand him, and his marker turns amber and stops pulsing while he waits, so
a stationary escortee looks like a waiting one rather than a stuck one.

A follower who could not path to his leader used to stand still for good; that
was the fault this replaced. In sight but unreachable by the search, he now
walks straight at the leader instead.

Concentrating the opposition into the second half made the escortee too
fragile: at sixty health he died in half of the runs, which is a mission you
lose rather than one you find hard. He carries `RESCUE_HP` now. Rivals aim at
agents and hold their fire when he is in the line, so what kills him is the
volume of stray fire - which means the spacing you keep is the skill the
mission asks for. Parked on top of him through the whole fight he survives four
runs in six; kept a few tiles ahead of him, six in six.

## Two markers, not one

The minimap carries the objective ping - wherever you are supposed to be going
next - and, separately, a marker on the mission's target for as long as he is
alive. On the way in those are the same place; on the way home they are not,
and you want to see both: the zone you are making for, and the man you are
supposed to be bringing to it.

The target's marker has to be drawn last and drawn loud. The first version was
a small ring in the same amber as a dropped item, drawn before the objective
ping - and the moment you had him he was standing a tile from four bright agent
dots and simply vanished into them. It is now a magenta ring with a dark collar
and a cross that reaches past the squad, painted after everything else, and
nothing else on the map is shaped like it. Measured in marker pixels inside the
minimap rectangle: twenty or so before contact, and *more* after, where before
the answer was "somewhere under the yellow".

## Botching rather than losing

A mission is no longer all or nothing. `Mission.score` runs 0 to 1 and scales
the completion bonus, and the debrief says what was missed: four of six
vehicles burned pays two thirds, an uplink held 45% of its window pays 45%, a
defector who reaches the boundary still pays the `ESCAPE_PAY` share for the
fight. A wipe is still a wipe. The point is that the campaign carries on: the
older missions could only be won or lost, and a lost one costs 1200cr an agent
to rebuild from, which turns one bad run into three bad ones.

## An order given where you already stand

Orders are settled in `onArrive`, which fires at the end of a path - so an
order given while the agent is already on the spot produced no path, never
arrived, and was never settled. Telling an agent to pick up the thing at his
feet left him standing over it for good. Any pending order with no path is now
settled where he stands: in range it completes, out of range it is dropped
rather than held forever. It was always broken; carrying a case to a zone is
just the first mission that made it obvious.

## Friendly fire

Every weapon but one fires a projectile, and projectiles have always skipped
the shooter's own team. The laser is hitscan -- it walks a beam out to its
range and damages everyone it passes through -- and it was checking only
whether a ped *was* the shooter, not whose side they were on. A squad strung
out in a line had one agent cutting down the other three: measured at full
health each, the three behind the muzzle went to nought. They take nothing now,
and the target at the far end still dies.

The other path is through cars, and it was every weapon rather than one. A
round is stopped by the first thing it touches, and the ped loop skips anyone
riding, so a shot aimed past the car the rest of the squad was in hit the car
instead - and wrecking it killed all three inside. Firing a pistol past the
squad car used to leave the car on 24 and everyone in it on 22; an uzi, a
shotgun, a minigun, a laser or a gauss round wrecked it outright and killed
them all. A shot now skips a car with one of the shooter's own side aboard.

The rule is *aboard*, not *owned*: an empty car is fair game whoever it belongs
to - blowing them up is half the point of them, and the chain that runs down a
row of parked cars depends on it - and so is a car with a rival crew in it. All
three still go up.

Gauss is not the same case and is left alone: it is a blast, and a blast that
spared your own side would be a different weapon. It is why a gauss round fired
past the squad car still leaves the riders hurt - the slug passes the car and
detonates beyond it, and the blast reaches back.

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

## The car fleet

The old line-up read as hovering boats, and the reason was structural rather
than cosmetic: every model was a flat-decked slab with a glass blister dropped
on it. The deck was the same height from nose to tail, the canopy was a
separate pod that ended in a wall, and the plan was a symmetric lozenge widest
amidships. No amount of new numbers fixes that, because the format could not
express a car. Five things were added to it:

- **`wedge`** - the deck climbs from nose to tail. A low nose is the single
  most recognisable modern-car cue and the old format had no way to ask for it.
  It is applied as a per-point ramp inside `loft`, so the hull, the canopy and
  a faired cargo volume all sit on the same rising line.
- **`hips`** - moves the widest point of the plan back over the rear axle and
  flares it, giving the body shoulders instead of a lozenge.
- **`fast`** - a fastback: the canopy runs out to the tail instead of stopping
  in a wall, so the glazing and the rear deck are one line.
- **`blade`** - one unbroken light bar across the nose and another across the
  tail. At night this does more for the look than the whole rest of the list.
- **`glassDrop`** - glazing carried down the flanks into a glasshouse, so there
  is a side window and a pillar to read rather than a dome perched on a deck.

A van's cargo box is now lofted on the body's own plan rather than extruded as
a rectangular prism - but only where `fast` is set, which is what keeps the
working half of the fleet looking welded.

The fleet is three families, not one. Thirteen concept cars take the treatment
above. Seven working machines - the hauler, the transit block, the patrol
wagon, the armoured SUV, the truck, the supron and the enforcer - are left
blunt on purpose: a city where every last van is a teardrop has nothing for the
sleek ones to be sleek against.

The other four are the original Bullfrog shape, and they needed a sixth
parameter. **`shell`** makes the dome *bodywork* rather than glazing: the same
lofted canopy, but drawn in the body colour with a glazing line scribed round
it at half height and a harder specular on the crown. That is the whole trick -
the classic car is not a hull with a cabin on it, it is one moulded piece from
sill to crown, and drawing the dome in glass is what stopped it reading that
way. Squat, wide in plan, near-black, no wedge and no blade. Four of
twenty-four, because the original game's streets were full of them.

The wedge has to be counted in the headroom check. It raises the tail, so
anything sitting back there sits that much higher, and a spoiler through a
garage ceiling is exactly the fault `vfit` exists to prevent.

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

## Lights

Every car used to carry a flat bar of light across the nose, drawn at the very
tip of the body and the full width of it. At the tip the hull plan has no
width at all, so the bar was a plate of light hanging in the air ahead of the
car -- on all 28 models, and by as much as a third of a tile clear of any
bodywork on the worst of them. The blade models hung a second plate in front
of that one.

Both are gone. A car now carries spot lamps set into the panel: a bezel of
shadowed bodywork, a lens, the pip where the reflector catches the sky, and
the bloom through the shared emissive pass. `lamps` says one big round unit
per side or two in a cluster; where each lamp sits is derived from the hull
plan's own half-width at that point, so a lamp is always in bodywork that is
actually there. A lamp on the end or the flank turned away from the camera is
not drawn.

A lit lamp and an unlit one are not the same object, and drawing them the
same way is what made the daytime cars look like they had eyes: a pale disc
with a white highlight in the middle of it is a cartoon eye, whatever it is
meant to be. At night the lens is the light source and keeps the reflector
pip and the bloom. By day it is dark glass -- a gradient catching the sky
across the top, falling to near black at the bottom, with a rim of housing
under it and no bloom at all. Measured over the two lenses of a shell, the
daylight mean falls from 134 to 56 while the night frame is unchanged.

## Bullfrog shell detail

The shell is one moulded piece, so everything that makes it read as a vehicle
has to be set into that piece. It carries a wrapped screen band with a frame
top and bottom rather than a single scribed line, one shut line down each
flank, a rubbing strip round the sill, louvres over the tail and classic
round quad lamps. Each is drawn only over the half of the body turned toward
the camera -- on a closed surface, the far side would otherwise show through.

## Fleet size

The fleet is 28 chassis, not 24. It grew rather than rotated: adding the
four Bullfrog shells originally cost four concept cars -- Thorton Hatch,
Alvarado, Mizutani and Chevalier -- to hold the count at 24, and those four
are back. A model costs nothing but a line of numbers, so a new family is a
reason to make the line-up longer, never to retire something that already
reads well on the street.

The spawner picks over `CAR_MODELS.length` rather than a hardcoded 23. That
constant is the reason growing the fleet used to be a two-file change: with
28 models and the old range, the last four would have been drawn by the
gallery and never once by the city.

## Night underglow

Every car casts a pool of its own accent light at night. That pool used to be
a flat additive quad the size of the car's footprint, and because it had a
hard rim it read as a paving slab in the wrong colour rather than as light --
on open road it stepped the ground by 17-23 levels along a straight edge and
lifted it to a luminance of 54 against a road sitting around 12.

It is now a radial falloff squashed onto the body axis: bright under the
car, nothing at the rim. The step across the same ground drops to 6 and the
brightest spill to 26, so the road under a car is the road beside it, lit.

## Prop resolution

Trees, benches and stalls are bitmaps baked once at their nominal pixel size
and then scaled up by the camera zoom -- to 3.4x on a hard pinch -- with the
main context's smoothing off for the pixel-art tiles. That turned every leaf
into a 3-4px block the moment you zoomed in.

They are now drawn at PROP_SS (4x) their size onto a context pre-scaled by
that factor, so every existing drawing routine is untouched, and handed to
the renderer to scale back down with smoothing on for that one blit. Within
the zoom range the sprite is only ever downscaled, never magnified, so the
canopy stays a smooth curve at every zoom while the tiles behind it keep
their blocks. Measured on a single canopy at full zoom, horizontal
identical-colour runs of 3px or more -- the fingerprint of block upscaling --
fall by about 60%, and frame time is unchanged.

## Shooting underground

Firing inside a garage did nothing, and it took three faults stacked on top
of each other, each of which alone was enough to eat the shot:

1. A manual fire order dropped its own height. `cmdShoot` records the target
   surface's z, but `updateAgent` called `fireWeapon` without it, so the shot
   aimed at street level (tz 0). An agent standing in a garage at z -1 thus
   launched every round up at the ceiling.
2. The projectile's "spent itself in the road" test was a flat `z < -0.2`.
   That is the street floor; a round travelling level at the garage floor of
   -1 tripped it on its first step and vanished.
3. The building-collision test ran on underground rounds too. A garage sits
   under a building tile, so a round at -1 was killed against the tower
   standing three storeys above it, exactly as if it had hit the wall.

The floor and building tests now both defer to the same rule the line-of-
sight check already uses: below the street the world is solid except where
the sector is hollowed out, so a round lives on wherever a shot was allowed
to travel, and the slab overhead is its roof rather than a wall in its path.
The same fix covers subway platforms, not just garages. Measured: an agent
firing four pistol rounds at an enemy four tiles away on the garage floor now
lands 78 damage with the rounds holding z -1 the whole way; before, zero.

## Boarding a car underground

Boarding a car parked in a garage failed for three reasons, in the same
spirit as the shooting bug:

1. The tap missed it. The car hit-test compared the tap against the street
   plane, but a garage car draws a storey up the screen, so the ground
   projection lands ~2.6 tiles from the car - well outside the tap radius.
   The tap is now projected to each car's own height, and a car is considered
   only where the section is actually drawing it, by the renderer's own `shown`
   rule, so a street car by a building is never mistaken for hidden.
2. It could not be reached. `cmdBoardCar` routed with the flat road search,
   which has no way down a ramp. It now uses the level-aware `climbPath` -
   over surfaces, through the ramp - whenever the car or the agent is off the
   street, exactly as `cmdMove` already did.
3. It launched into a wall. On boarding, a parked car glides out to the
   nearest street lane; for a garage car that meant sliding through the
   bay wall. A car underground now simply becomes player-controlled where it
   stands, so the player drives it up the ramp.

Measured: an agent on the street tapping a garage car walks down the ramp and
boards (path found, aboard in ~1.2s), the car takes the wheel in place, and
driving it back out climbs z -1 to 0 up the ramp. Kerbside boarding is
unchanged - all four agents still board a street car on a tap.

## Car length and spacing

No car may be longer than three tiles. The body runs nose to tail over 2*L
and a ram bar pushes the nose out a further tenth, so the true half-extent is
L*(bull?1.1:1); a load-time pass scales L down wherever that would top 1.5
tiles, the same way vfit caps height. Five chassis were over - the Zorg Limo
was 3.9 tiles - and are now exactly 3; the guarantee holds for any chassis
added later. cabF/cabB are fractions of L, so a shortened body keeps its
canopy in proportion.

Length alone was not the whole of it. A car kept its distance by a flat
range and separated on a fixed one-tile circle, both blind to how long a car
is, so two long ones lapped over each other end to end - a pair of limos
overlapped by a tile and a half at rest. The following gap is now each car's
front half plus the other's rear half; the separation treats a car as a box
in its own frame and prises an overlapping pair apart on whichever axis they
are least buried in, so a queue opens up nose to tail without shouldering the
next lane. Measured: worst body overlap for two queued limos falls from 1.48
tiles to 0, traffic still reaches every junction, and parked-bay clearance
even improves.

## Edge turnarounds

An avenue runs clear to the map border. The outgoing lane used to arrive at
the edge with nowhere to go, and the car drove off and wrecked - 36 to 38
such dead-end tiles per sector. Each avenue end now wears a mini-roundabout:
a point island (no tile of its own) with road on all four sides, two by two,
that folds the arriving lane back into the departing one so traffic returns
toward the centre. The four tiles circulate like any roundabout; the one that
meets the departing lane also carries that lane's direction, which is the exit
a car takes going straight out of the loop. All four were already paved road,
so this only rewires which way a car may leave each. Measured: off-map exit
tiles fall from ~37 to 0, and a car driven into an edge turns around and heads
back instead of wrecking, on every seed.

The border itself gets a cosmetic apron: past the edge each avenue is redrawn
for a few tiles, fading to nothing, so the grid does not read as a hard
rectangular cut and the turnaround sits on a road that looks like it carries
on out of the sector. It is drawn only at street level and has no tile or lane
behind it.

## Research, implants, and the gated armory

Between missions the franchise now runs a lab. Money is the only resource: a
project is bought outright on the research screen, gated by the node before it
in its branch. Four branches -- guns (UZI > SHOTGUN > MINIGUN), tech weapons
(LASER > GAUSS), defense (MEDKIT > SHIELD BELT > PERSUADERTRON), and body
implants, one chain of three marks per body part. The pistol is standard
issue and needs no research; nothing else can be bought at the armory until
the lab delivers it. Unresearched market cards show as locked silhouettes, so
the armory doubles as a map of what research can open. Loot is exempt: a
minigun taken off a corpse works no matter whose lab it came from.

Implants are researched per part and per mark, then bought and installed on
an agent at the clinic -- a doll with a tappable region per body part, MK
badges on both the doll and the catalogue. They die with the agent: a hired
replacement arrives bare. What the marks do in the field:

  LEG SERVOS        +15/30/50% move speed
  CHEST PLATING     +50/100/150 max HP (the panel bar already scales by maxHp)
  ARM ACTUATORS     weapon cooldown x0.85/0.65/0.5
  TARGETING OPTICS  reaction delay x0.6/0.35/0.1

The optics needed a baseline to cut: an agent acquiring a fresh target now
takes a 0.3-0.55s draw before auto-fire opens up (NPCs have always had
0.55-0.95s). An explicit fire order never waits -- an order is aimed by the
player, not the agent. Measured on the range: time to first shot 367ms bare
against 50ms with MK.III optics; an UZI puts out 30 rounds in 3s bare and 60
with MK.III actuators; a manual order fires on frame 0 either way.

Old saves migrate: a campaign from before the lab loads with an empty tree
and bare agents, and every purchase writes the save immediately.

## The second arsenal

Each research area grew a second chain of three. Guns: SILENCED PISTOL (the
one gun the street does not hear - firing it raises no alarm; only the body
dropping does), LONG RIFLE (18-tile reach, kill before contact), FLAMER (a
short cone of fire, two pellets a tick). Tech, built on the laser: PULSE
LASER (an automatic beam, four times the laser's rate), ARC THROWER
(lightning that forks from the victim to up to two more hostiles within
three tiles, weakening 30% an arc - and it has manners: a player's arc never
jumps to a civilian), PLASMA LANCE (a beam a full tile wide that catches the
men a laser's line misses). Defense: TIME BOMB (lobbed up to five tiles,
four-second fuse, the standard blast), GAS GRENADE (a three-tile cloud that
knocks everyone in it out cold for its eight seconds, harming nobody and
raising no heat), CLOAK FIELD (drains like the shield; hostiles cannot
acquire a cloaked agent, and the veil tears the moment he fires).

Mechanics grown for them, all declared on the item: `silent` skips the shot
alert, `beam` generalises the laser path (with `wide` for the lance and
`chain` for the arc), `device` lobs a charge to the spot instead of firing,
and `auto: false` keeps the bombs out of an agent's own hands - devices are
thrown on an explicit order only, and never auto-swapped to when a gun runs
dry. Stunned bodies stand down for the cloud plus half a second; a cloaked
agent renders as a shimmer and his slot glows violet like the shield's green.

Measured, one pass over all nine: a pistol shot sends 7 of 8 bystanders
fleeing, the silenced shot none; the rifle auto-engages at 14 tiles; the
flamer burns three at once; pulse fires 20 beams to the laser's 5 in 3s; one
arc bolt hurts three men; the lance catches both of a pair the laser line
clips one of; the bomb goes off at 4.0s; the gassed dummy is stunned, unhurt,
and back up when the cloud fades; a gunman three tiles from a cloaked agent
lands nothing for 3s and the cloak drops on the agent's first shot.

## Wide ramps, clean rings, and giving way

Garage ramps are two tiles wide. The mouth search now accepts a candidate
only when a parallel column works beside it - its own road mouth off the
same carriageway, every step rampable, the last one landing on the garage
floor, and neither mouth on or beside a zebra. Both columns chain down in
step and sit side by side at every depth, so the level-aware searches join
them by adjacency and a car may take either lane. The renderer draws the
pair as one cut: parts carry the pair's centre and the trench, portal, deck
and chevrons all draw about it, twice as wide. Not one garage was lost to
the stricter rule, and the entrance audit holds: per garage, exactly one
ramp (two mouths), zero links to foreign surfaces, zero open edges - the
ramp is the only way in or out, for cars and agents alike.

A roundabout's circulating lane draws plain road. The dash tiles marked the
one-way lanes of a straight carriageway, and a ring tile carries exactly the
lane bits that triggered them, so every ring wore centre-line dashes as if
the junction were an avenue.

And one car on a roundabout at a time: the ring array now carries a region
id per roundabout, and a car rolling up on a ring that another car is
already circulating eases to a stop at the give-way line - a gentler brake
than the traffic-queue stop - and enters only once that ring is empty.
Measured: two cars sent up one approach never share the ring (0 frames),
the second enters 0.3s after the first leaves, minimum gap 4 tiles; across
the whole city the worst crowding on any one ring falls from 3 cars to 1,
with traffic still flowing.

## Round roundabouts

A circle in world space projects to an axis-aligned ellipse on screen with
rx:ry in the tile ratio, so the square 2x2 island is repainted as a kerbed
disc - kerb ring, paved centre, trim ring - and a dashed circular lane guide
runs through the middle of the circulating lane. Together they make the
junction read as round even though every tile under it stays square; the
island tiles now carry the road surface beneath the disc.

In the middle stands a hologram: an emitter drum on the island projecting a
wireframe globe. Latitude rings squash with the iso view, meridians breathe
in width as the globe spins, a tracer rides the equator to mark the
direction, scanlines drift through the projection, and the whole thing
flickers slightly, as a projection should. Colour comes from the island's
own coordinates, so neighbouring roundabouts differ; at night the globe
carries its own glow. Drawn in the depth buckets, so towers in front of it
occlude it correctly. Frame time with the whole sector on screen is
unchanged.

## Burning wrecks

A wreck was a flat black octagon with a rectangle for a burst canopy, and it
went cold the moment the explosion's own particles faded. Now it is a
buckled hulk that keeps burning.

The body is drawn from a per-id seed so its debris field holds still frame to
frame: eight charred chunks and torn panels flung clear and scattered around
the footprint (sorted far-to-near so they overlap correctly), two crumpled
masses of different heights on a jagged asymmetric plan so the silhouette is
uneven and stands well clear of the ground, a torn panel canted off one
flank, a wide scorch on the tarmac, and a wound at the core still glowing and
breathing with the fire.

The fire never stops. Each update, every wreck the camera can see (culled at
48 tiles, which bounds the particle count) emits a steady flame plus the odd
gout of smoke and a spark, from a hot spot chosen randomly across the hulk so
the whole thing is alight rather than one candle. Measured over 30 seconds on
three wrecks: live flames never fall below 22 after the initial blast has
faded, holding around 25-30 with smoke and sparks alongside, about 60
particles in all - and frame time with the whole sector on screen is
unchanged.

## Flames, soot, and a wreck the size of the car

The wreck is now built to the model's own dimensions rather than to guessed
numbers: the floor pan takes the car's plan, the buckled masses sit inside
+-L and +-W, and every height is measured from the same ground clearance the
car uses and reaches the model's own hull and roof. Measured against the live
car it replaces, at the same spot and model, the wreck's footprint is 103% of
the car's width; it stands lower, which is what being crushed means. The
scorch is sized to the car's own shadow so the stain does not read as a
bigger vehicle. Detail on top of that: burnt tyres on the rims, a scorched
floor pan, a collapsed cabin canted to one side, bare spars where the roof
tore off, a door hanging open, a half-torn bumper, rust and bare-metal
patches burned through the soot, and small bits fallen within the outline.

Fire was a radial gradient - a coloured light, not a flame. A flame is now a
tongue: a tapering polygon that leans and wobbles as it rises, necking and
bulging along its length so the edge is never a clean arc, filled hot at the
root and fading out at the tip, with a brighter core inside. Overlapping
tongues pile up additively into one convoluted mass. Smoke is black soot off
the hot part of the wreck, climbing hard and swelling, two lobes per puff so
a column billows, greying only as it disperses.

Both are drawn hundreds of times a frame, so the cost matters: building a
radial gradient per smoke puff took six burning wrecks to 66.6ms a frame. The
ramp is now baked once into a sprite and blitted, and a flame's core is a flat
fill rather than a second gradient, which puts the same scene back at 33.4ms
- the same as a city with no fire in it at all.

## The flame shader

There is no GPU shader to write here - the whole game draws through a 2D
canvas - so the flame *is* the shader: the same per-pixel maths a fragment
shader would run, evaluated on the CPU and baked once into a seamless
flipbook at load. The runtime then blits frames, so the most convincing fire
in the game is also the cheapest thing on screen.

The technique is what real-time fire shaders actually do:

  fBm value noise   octaves summed at halving amplitude, giving structure at
                    every scale instead of one blobby frequency.
  domain warping    the noise is sampled at coordinates displaced by a second
                    noise field. This is the step that turns smooth blobs into
                    licking, curling tongues, and it does more for realism
                    than everything else combined.
  a body mask       fire exists only inside a plume that narrows with height;
                    the turbulence then eats into that silhouette, so the edge
                    is ragged and wisps detach at the top on their own.
  blackbody colour  heat maps through the colours a radiating body actually
                    passes through - soot red, orange, amber, straw, white -
                    rather than a hand-picked gradient, with a touch of blue at
                    the root where combustion is complete.

The loop is seamless because the noise lattice wraps on a fixed period in the
vertical axis and one cycle scrolls it by exactly that period. Each particle
enters the loop at its own phase and scale, so no two flames in a fire are
ever in step, and a wreck now wants a handful of big flames rather than a
swarm of small ones.

Cost: 24 frames of 48x80 bake in 57ms once, behind the sector-generation
screen, for 360KB of frames. Six burning wrecks in one shot still run at
33.3ms a frame - the same as a city with no fire in it.
