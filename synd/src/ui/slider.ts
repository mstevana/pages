// The section slider: a vertical track down the right edge of the viewport
// that chooses the height of the horizontal cross-section through the city.
// Ground plane at the bottom, the tallest roof in the sector at the top; at
// the top the city stands whole.

const W = 34;          // track width in css px
const MARGIN = 10;
const THUMB = 26;

export interface SliderGeom { x: number; y: number; w: number; h: number; }

export class SectionSlider {
  // the track runs from minLevel at the bottom to maxLevel at the top, so a
  // sector with basements under it simply starts lower than zero
  constructor(public maxLevel: number, public minLevel = 0) {}

  // the track's box inside a viewport
  geom(vx: number, vy: number, vw: number, vh: number): SliderGeom {
    const w = Math.max(26, Math.min(46, vw * 0.05));
    const h = Math.max(90, vh - MARGIN * 2 - 34);
    return { x: vx + vw - w - MARGIN, y: vy + MARGIN + 24, w, h: h - 24 };
  }

  // is this press on the slider?
  hit(px: number, py: number, gm: SliderGeom): boolean {
    return px >= gm.x - 8 && px <= gm.x + gm.w + 8 && py >= gm.y - 20 && py <= gm.y + gm.h + 20;
  }

  // which level does a y inside the track select? bottom is the ground plane
  levelAt(py: number, gm: SliderGeom): number {
    const f = 1 - (py - gm.y) / gm.h;
    const span = this.maxLevel - this.minLevel;
    return Math.round(this.minLevel + Math.max(0, Math.min(1, f)) * span);
  }

  draw(g: CanvasRenderingContext2D, gm: SliderGeom, level: number): void {
    const off = level >= this.maxLevel;
    const span = Math.max(1, this.maxLevel - this.minLevel);
    const f = (level - this.minLevel) / span;
    const ty = gm.y + (1 - f) * gm.h;
    const zeroY = gm.y + (1 - (0 - this.minLevel) / span) * gm.h;

    g.save();
    // track
    g.fillStyle = "rgba(8,10,16,0.72)";
    g.strokeStyle = off ? "#3a4560" : "#ff9b2f";
    g.lineWidth = 1;
    g.fillRect(gm.x, gm.y, gm.w, gm.h);
    g.strokeRect(gm.x + 0.5, gm.y + 0.5, gm.w - 1, gm.h - 1);
    // storey ticks, brighter for the ones still standing
    const step = Math.max(1, Math.ceil(span / 16));
    for (let l = this.minLevel; l <= this.maxLevel; l += step) {
      const y = gm.y + (1 - (l - this.minLevel) / span) * gm.h;
      g.fillStyle = l <= level ? "rgba(255,155,47,0.55)" : "rgba(120,140,180,0.3)";
      g.fillRect(gm.x + 4, Math.round(y), gm.w - 8, 1);
    }
    // street level, so it is obvious which side of it the plane is on
    if (this.minLevel < 0) {
      g.fillStyle = "rgba(150,200,255,0.75)";
      g.fillRect(gm.x + 1, Math.round(zeroY), gm.w - 2, 1);
    }
    // the plane itself
    if (!off) {
      g.fillStyle = "rgba(255,155,47,0.18)";
      g.fillRect(gm.x, ty, gm.w, gm.y + gm.h - ty);
    }
    // thumb
    g.fillStyle = off ? "#1a2030" : "#ff9b2f";
    g.strokeStyle = off ? "#6b7b9c" : "#ffd7a0";
    const th = THUMB;
    g.fillRect(gm.x - 3, ty - th / 2, gm.w + 6, th);
    g.strokeRect(gm.x - 2.5, ty - th / 2 + 0.5, gm.w + 5, th - 1);
    g.fillStyle = off ? "#8fa2c4" : "#1a1206";
    g.font = `bold ${Math.round(th * 0.5)}px monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(off ? "ALL" : String(level), gm.x + gm.w / 2, ty);
    // caption
    g.fillStyle = off ? "#6b7b9c" : "#ff9b2f";
    g.font = `bold ${Math.round(Math.min(13, gm.w * 0.38))}px monospace`;
    g.fillText("LVL", gm.x + gm.w / 2, gm.y - 12);
    g.restore();
  }
}
