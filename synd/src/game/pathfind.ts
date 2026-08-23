// Grid pathfinding: 8-way A* for pedestrians, lane-directed A* for cars.

import { City, DBIT, DX, DY, T_ROAD, idx, inGrid, isWalkable, surfaceZ, walkableAt } from "../city/citygen";
import { GRID } from "../engine/util";

const MAX_EXPAND = 60000;
const CELLS = GRID * GRID;      // one slot's worth of search space
export interface Step { x: number; y: number; z: number }

class Heap {
  keys: number[] = [];
  vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, val: number): void {
    const k = this.keys, v = this.vals;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.keys, v = this.vals;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length > 0) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
  clear(): void { this.keys.length = 0; this.vals.length = 0; }
}

export class Pathfinder {
  private g = new Float32Array(GRID * GRID);
  private g2 = new Float32Array(GRID * GRID * 2);
  private came2 = new Int32Array(GRID * GRID * 2);
  private stamp2 = new Int32Array(GRID * GRID * 2);
  private came = new Int32Array(GRID * GRID);
  private stamp = new Int32Array(GRID * GRID);
  private gen = 0;
  private heap = new Heap();

  constructor(private city: City) {}

  // Pedestrian path. Returns waypoints in tile-center coords, or null.
  walkPath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] | null {
    const c = this.city;
    sx |= 0; sy |= 0; tx |= 0; ty |= 0;
    if (!isWalkable(c, tx, ty)) {
      const near = this.nearestWalkable(tx, ty, 6);
      if (!near) return null;
      tx = near.x; ty = near.y;
    }
    if (!isWalkable(c, sx, sy)) {
      const near = this.nearestWalkable(sx, sy, 6);
      if (!near) return null;
      sx = near.x; sy = near.y;
    }
    if (sx === tx && sy === ty) return [{ x: tx + 0.5, y: ty + 0.5 }];

    this.gen++;
    const { g, came, stamp, heap } = this;
    heap.clear();
    const si = idx(sx, sy), ti = idx(tx, ty);
    g[si] = 0; stamp[si] = this.gen; came[si] = -1;
    heap.push(this.hDist(sx, sy, tx, ty), si);
    let expanded = 0;
    let found = false;
    while (heap.size > 0 && expanded < MAX_EXPAND) {
      const cur = heap.pop();
      if (cur === ti) { found = true; break; }
      expanded++;
      const cx = cur % GRID, cy = (cur / GRID) | 0;
      for (let dyy = -1; dyy <= 1; dyy++) {
        for (let dxx = -1; dxx <= 1; dxx++) {
          if (dxx === 0 && dyy === 0) continue;
          const nx = cx + dxx, ny = cy + dyy;
          if (!isWalkable(c, nx, ny)) continue;
          // no diagonal corner cutting
          if (dxx !== 0 && dyy !== 0 && (!isWalkable(c, cx + dxx, cy) || !isWalkable(c, cx, cy + dyy))) continue;
          const ni = idx(nx, ny);
          const step = dxx !== 0 && dyy !== 0 ? 1.4142 : 1;
          // prefer sidewalks and roads slightly over rough ground
          const t = c.tiles[ni];
          const cost = step * (t === T_ROAD ? 1.05 : 1);
          const ng = g[cur] + cost;
          if (stamp[ni] !== this.gen || ng < g[ni]) {
            stamp[ni] = this.gen; g[ni] = ng; came[ni] = cur;
            heap.push(ng + this.hDist(nx, ny, tx, ty), ni);
          }
        }
      }
    }
    if (!found && stamp[ti] !== this.gen) return null;
    const path: { x: number; y: number }[] = [];
    let cur = ti;
    while (cur !== -1 && path.length < 4096) {
      path.push({ x: (cur % GRID) + 0.5, y: ((cur / GRID) | 0) + 0.5 });
      cur = came[cur];
      if (cur !== -1 && stamp[cur] !== this.gen) break;
    }
    path.reverse();
    return this.smooth(path);
  }

  // Level-aware pedestrian path. Nodes are (tile, slot): slot 0 is the street,
  // slot 1 the roof or platform above it, and a fire stair is the rung between
  // them. Returns waypoints carrying the height to walk them at.
  climbPath(sx: number, sy: number, sslot: number, tx: number, ty: number, tslot: number): Step[] | null {
    const c = this.city;
    sx |= 0; sy |= 0; tx |= 0; ty |= 0;
    if (!walkableAt(c, sx, sy, sslot) || !walkableAt(c, tx, ty, tslot)) return null;
    const si = idx(sx, sy) + sslot * CELLS, ti = idx(tx, ty) + tslot * CELLS;
    if (si === ti) return [{ x: tx + 0.5, y: ty + 0.5, z: surfaceZ(c, tx, ty, tslot) }];

    this.gen++;
    const { g2, came2, stamp2, heap } = this;
    heap.clear();
    g2[si] = 0; stamp2[si] = this.gen; came2[si] = -1;
    heap.push(this.hDist(sx, sy, tx, ty), si);
    let expanded = 0, found = false;
    while (heap.size > 0 && expanded < MAX_EXPAND) {
      const cur = heap.pop();
      if (cur === ti) { found = true; break; }
      expanded++;
      const slot = cur >= CELLS ? 1 : 0;
      const cell = cur - slot * CELLS;
      const cx = cell % GRID, cy = (cell / GRID) | 0;
      const cz = surfaceZ(c, cx, cy, slot);
      // step across this level
      for (let dyy = -1; dyy <= 1; dyy++) {
        for (let dxx = -1; dxx <= 1; dxx++) {
          if (dxx === 0 && dyy === 0) continue;
          const nx = cx + dxx, ny = cy + dyy;
          if (!walkableAt(c, nx, ny, slot)) continue;
          if (surfaceZ(c, nx, ny, slot) !== cz) continue;   // no stepping between roofs
          if (dxx !== 0 && dyy !== 0
              && (!walkableAt(c, cx + dxx, cy, slot) || !walkableAt(c, cx, cy + dyy, slot))) continue;
          const ni = idx(nx, ny) + slot * CELLS;
          const step = dxx !== 0 && dyy !== 0 ? 1.4142 : 1;
          this.relax(cur, ni, step, nx, ny, tx, ty);
        }
      }
      // and the rung between them, wherever a stair stands
      if (slot === 0) {
        const roof = c.stairTo[cell];
        if (roof >= 0) {
          const rx = roof % GRID, ry = (roof / GRID) | 0;
          this.relax(cur, roof + CELLS, 1 + c.structZ[roof] * 1.5, rx, ry, tx, ty);
        }
      } else {
        for (let dyy = -1; dyy <= 1; dyy++) {
          for (let dxx = -1; dxx <= 1; dxx++) {
            const gx = cx + dxx, gy = cy + dyy;
            if (!inGrid(gx, gy)) continue;
            const gi = idx(gx, gy);
            if (c.stairTo[gi] !== cell) continue;
            this.relax(cur, gi, 1 + cz * 1.5, gx, gy, tx, ty);
          }
        }
      }
    }
    if (!found && stamp2[ti] !== this.gen) return null;
    const out: Step[] = [];
    let cur = ti;
    while (cur !== -1 && out.length < 4096) {
      const slot = cur >= CELLS ? 1 : 0;
      const cell = cur - slot * CELLS;
      const px = cell % GRID, py = (cell / GRID) | 0;
      out.push({ x: px + 0.5, y: py + 0.5, z: surfaceZ(c, px, py, slot) });
      cur = came2[cur];
      if (cur !== -1 && stamp2[cur] !== this.gen) break;
    }
    out.reverse();
    return out;
  }

  private relax(cur: number, ni: number, cost: number, nx: number, ny: number, tx: number, ty: number): void {
    const ng = this.g2[cur] + cost;
    if (this.stamp2[ni] !== this.gen || ng < this.g2[ni]) {
      this.stamp2[ni] = this.gen; this.g2[ni] = ng; this.came2[ni] = cur;
      this.heap.push(ng + this.hDist(nx, ny, tx, ty), ni);
    }
  }

  // Car path along lane directions. Falls back to undirected road A* if the
  // directed graph can't reach (safety net for odd junctions).
  drivePath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] | null {
    const p = this.roadAStar(sx | 0, sy | 0, tx | 0, ty | 0, true);
    if (p) return p;
    return this.roadAStar(sx | 0, sy | 0, tx | 0, ty | 0, false);
  }

  private roadAStar(sx: number, sy: number, tx: number, ty: number, directed: boolean): { x: number; y: number }[] | null {
    const c = this.city;
    if (!inGrid(sx, sy) || !inGrid(tx, ty)) return null;
    if (c.tiles[idx(tx, ty)] !== T_ROAD) {
      const near = this.nearestRoad(tx, ty, 8);
      if (!near) return null;
      tx = near.x; ty = near.y;
    }
    if (c.tiles[idx(sx, sy)] !== T_ROAD) {
      const near = this.nearestRoad(sx, sy, 4);
      if (!near) return null;
      sx = near.x; sy = near.y;
    }
    this.gen++;
    const { g, came, stamp, heap } = this;
    heap.clear();
    const si = idx(sx, sy), ti = idx(tx, ty);
    g[si] = 0; stamp[si] = this.gen; came[si] = -1;
    heap.push(this.hDist(sx, sy, tx, ty), si);
    let expanded = 0;
    while (heap.size > 0 && expanded < MAX_EXPAND) {
      const cur = heap.pop();
      if (cur === ti) {
        const path: { x: number; y: number }[] = [];
        let n = cur;
        while (n !== -1 && path.length < 4096) {
          path.push({ x: (n % GRID) + 0.5, y: ((n / GRID) | 0) + 0.5 });
          n = came[n];
        }
        path.reverse();
        return path;
      }
      expanded++;
      const cx = cur % GRID, cy = (cur / GRID) | 0;
      const bits = c.laneDir[cur];
      for (let d = 0; d < 4; d++) {
        if (directed && (bits & DBIT[d]) === 0) continue;
        const nx = cx + DX[d], ny = cy + DY[d];
        if (!inGrid(nx, ny) || c.tiles[idx(nx, ny)] !== T_ROAD) continue;
        const ni = idx(nx, ny);
        const ng = g[cur] + 1;
        if (stamp[ni] !== this.gen || ng < g[ni]) {
          stamp[ni] = this.gen; g[ni] = ng; came[ni] = cur;
          heap.push(ng + this.hDist(nx, ny, tx, ty), ni);
        }
      }
    }
    return null;
  }

  private hDist(x0: number, y0: number, x1: number, y1: number): number {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
  }

  nearestWalkable(x: number, y: number, r: number): { x: number; y: number } | null {
    for (let rad = 0; rad <= r; rad++) {
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        if (isWalkable(this.city, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
    return null;
  }

  nearestRoad(x: number, y: number, r: number): { x: number; y: number } | null {
    for (let rad = 0; rad <= r; rad++) {
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const nx = x + dx, ny = y + dy;
        if (inGrid(nx, ny) && this.city.tiles[idx(nx, ny)] === T_ROAD) return { x: nx, y: ny };
      }
    }
    return null;
  }

  // Line of sight across walkable tiles (for path smoothing and shooting).
  losWalk(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.los(x0, y0, x1, y1, (x, y) => isWalkable(this.city, x, y));
  }
  // Line of sight for a shot between two heights. A building only blocks where
  // it is taller than the shot passing over it, so an agent on a roof can fire
  // across the ones below - and the street can fire back.
  losShot3(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const c = this.city;
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.floor(x0 + (x1 - x0) * t), y = Math.floor(y0 + (y1 - y0) * t);
      if (!inGrid(x, y)) return false;
      const tt = c.tiles[idx(x, y)];
      if (tt !== 3 && tt !== 4) continue;              // WALL / BUILDING
      if (c.height[idx(x, y)] > z0 + (z1 - z0) * t + 0.1) return false;
    }
    return true;
  }

  // Line of sight for bullets: blocked only by buildings/walls.
  losShot(x0: number, y0: number, x1: number, y1: number): boolean {
    const c = this.city;
    return this.los(x0, y0, x1, y1, (x, y) => {
      if (!inGrid(x, y)) return false;
      const t = c.tiles[idx(x, y)];
      return t !== 3 && t !== 4; // WALL / BUILDING
    });
  }
  private los(x0: number, y0: number, x1: number, y1: number, ok: (x: number, y: number) => boolean): boolean {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!ok(Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t))) return false;
    }
    return true;
  }

  private smooth(path: { x: number; y: number }[]): { x: number; y: number }[] {
    if (path.length <= 2) return path;
    const out: { x: number; y: number }[] = [path[0]];
    let anchor = 0;
    for (let i = 2; i < path.length; i++) {
      if (!this.losWalk(path[anchor].x, path[anchor].y, path[i].x, path[i].y)) {
        out.push(path[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(path[path.length - 1]);
    return out;
  }
}
