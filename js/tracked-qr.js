// qcolortrasfer tracked QR sampler (MIT).
//
// Independent high-throughput tracked decoder support. A normal QR decode first
// establishes the symbol quad + module count. Subsequent crops reuse that
// geometry, cheaply re-lock the three finder patterns independently, rebuild
// the homography, derive local luminance thresholds and sample the known module
// grid without a global finder search. Alignment-pattern residuals then provide
// a bounded correction for moderate lens bow / non-projective distortion.
//
// This is original qcolortrasfer code. The architecture is informed by public
// performance characteristics of Decimen >=0.4, but no AGPL source is copied,
// translated or adapted.

export const TRACKED_MIN_LUMA_SEPARATION = 24;
export const TRACKED_THRESHOLD_TILES = 8;
export const TRACKED_TILE_PROBES = 4;
export const TRACKED_FINDER_SEARCH_PX = 3;
export const TRACKED_FINDER_MIN_SCORE = 120; // aggregate core score, max 147
export const TRACKED_ALIGNMENT_MIN_SCORE = 20; // max 25
export const TRACKED_MAX_ALIGNMENT_ANCHORS = 8;

const ALIGNMENT_CENTERS = Object.freeze([
  null,
  [],
  [6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],
  [6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],
  [6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],
  [6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],
  [6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],
  [6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],
  [6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],
  [6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],
  [6,30,58,86,114,142,170]
]);

export function modulesFromVersion(version) {
  const v = Math.floor(Number(version) || 0);
  return v >= 1 && v <= 40 ? 17 + 4 * v : 0;
}

export function versionFromModules(modules) {
  const m = Math.floor(Number(modules) || 0);
  const version = (m - 17) / 4;
  return Number.isInteger(version) && version >= 1 && version <= 40 ? version : 0;
}

export function alignmentPatternCenters(version) {
  const v = Math.floor(Number(version) || 0);
  return v >= 1 && v <= 40 ? [...(ALIGNMENT_CENTERS[v] || [])] : [];
}

export function shiftQuad(quad, dx = 0, dy = 0) {
  if (!quad?.topLeft || !quad?.topRight || !quad?.bottomLeft || !quad?.bottomRight) return null;
  const shift = point => ({ x: Number(point.x) + dx, y: Number(point.y) + dy });
  const out = {
    topLeft: shift(quad.topLeft), topRight: shift(quad.topRight),
    bottomLeft: shift(quad.bottomLeft), bottomRight: shift(quad.bottomRight),
  };
  return Object.values(out).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? out : null;
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

export function homographyForQr(modules, quad) {
  const q = shiftQuad(quad, 0, 0);
  if (!q || !(modules > 0)) return null;
  const src = [[0,0],[modules,0],[0,modules],[modules,modules]];
  const dst = [
    [q.topLeft.x,q.topLeft.y],[q.topRight.x,q.topRight.y],
    [q.bottomLeft.x,q.bottomLeft.y],[q.bottomRight.x,q.bottomRight.y]
  ];
  const matrix = [], vector = [];
  for (let i = 0; i < 4; i++) {
    const [x,y] = src[i], [u,v] = dst[i];
    matrix.push([x,y,1,0,0,0,-u*x,-u*y]); vector.push(u);
    matrix.push([0,0,0,x,y,1,-v*x,-v*y]); vector.push(v);
  }
  const h = solveLinearSystem(matrix, vector);
  return h ? [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1] : null;
}

export function mapHomography(h, x, y) {
  if (!h) return null;
  const d = h[6]*x + h[7]*y + h[8];
  if (Math.abs(d) < 1e-9) return null;
  return [(h[0]*x+h[1]*y+h[2])/d, (h[3]*x+h[4]*y+h[5])/d];
}

function rgbLuma(r,g,b) { return (77*r + 150*g + 29*b) / 256; }
function lumaAt(image, x, y) {
  const xx = Math.floor(x), yy = Math.floor(y);
  if (xx < 0 || yy < 0 || xx >= image.width || yy >= image.height) return null;
  const offset = (yy * image.width + xx) * 4;
  return rgbLuma(image.data[offset], image.data[offset+1], image.data[offset+2]);
}

export function clusterLuma(values, minSeparation = TRACKED_MIN_LUMA_SEPARATION) {
  if (!values?.length) return null;
  let dark = 255, light = 0;
  for (const value of values) { if (value < dark) dark = value; if (value > light) light = value; }
  if (!(light > dark)) return null;
  for (let iteration = 0; iteration < 6; iteration++) {
    const mid = (dark + light) / 2;
    let darkSum=0,darkN=0,lightSum=0,lightN=0;
    for (const value of values) {
      if (value <= mid) { darkSum += value; darkN++; }
      else { lightSum += value; lightN++; }
    }
    if (!darkN || !lightN) return null;
    dark = darkSum/darkN; light = lightSum/lightN;
  }
  const separation = light-dark;
  if (separation < minSeparation) return null;
  return { dark, light, threshold:(dark+light)/2, separation };
}

export function buildLocalThresholdGrid(image, h, modules, offset = {x:0,y:0}) {
  if (!image?.data || !h || !(modules > 0)) return null;
  const tiles = TRACKED_THRESHOLD_TILES, probes = TRACKED_TILE_PROBES;
  const thresholds = new Float32Array(tiles * tiles);
  const lows = new Float32Array(tiles * tiles); lows.fill(255);
  const highs = new Float32Array(tiles * tiles);
  let globalLow = 255, globalHigh = 0;
  const tileSize = modules / tiles;
  for (let ty=0; ty<tiles; ty++) for (let tx=0; tx<tiles; tx++) {
    const index=ty*tiles+tx;
    for (let sy=0; sy<probes; sy++) for (let sx=0; sx<probes; sx++) {
      const mx=(tx+(sx+0.5)/probes)*tileSize, my=(ty+(sy+0.5)/probes)*tileSize;
      const p=mapHomography(h,mx,my); if(!p) continue;
      const lum=lumaAt(image,p[0]+offset.x,p[1]+offset.y); if(lum==null) continue;
      if(lum<lows[index]) lows[index]=lum; if(lum>highs[index]) highs[index]=lum;
      if(lum<globalLow) globalLow=lum; if(lum>globalHigh) globalHigh=lum;
    }
  }
  const separation=globalHigh-globalLow;
  if (separation < TRACKED_MIN_LUMA_SEPARATION) return null;
  const globalThreshold=(globalLow+globalHigh)/2;
  for(let i=0;i<thresholds.length;i++) thresholds[i]=highs[i]-lows[i]>=TRACKED_MIN_LUMA_SEPARATION?(highs[i]+lows[i])/2:globalThreshold;
  return {tiles,thresholds,separation,globalThreshold,modules};
}

function thresholdAt(grid,mx,my) {
  const tx=Math.max(0,Math.min(grid.tiles-1,Math.floor(mx*grid.tiles/grid.modules)));
  const ty=Math.max(0,Math.min(grid.tiles-1,Math.floor(my*grid.tiles/grid.modules)));
  return grid.thresholds[ty*grid.tiles+tx];
}

function darkAt(image,h,grid,mx,my,offset={x:0,y:0}) {
  const p=mapHomography(h,mx,my); if(!p) return false;
  const lum=lumaAt(image,p[0]+offset.x,p[1]+offset.y);
  return lum != null && lum <= thresholdAt(grid,mx,my);
}

function finderIdeal(x,y) { return x===0 || x===6 || y===0 || y===6 || (x>=2&&x<=4&&y>=2&&y<=4); }

function finderPatternScore(image,h,grid,cx,cy,offset) {
  let core=0, separator=0;
  for(let y=0;y<7;y++) for(let x=0;x<7;x++) {
    if(darkAt(image,h,grid,cx+x+0.5,cy+y+0.5,offset)===finderIdeal(x,y)) core++;
  }
  // The reserved one-module separator surrounding a finder is white. Including
  // it as a tie-breaker removes the broad score plateaus seen at 3–4 px/module.
  for(let t=-1;t<=7;t++) {
    if(!darkAt(image,h,grid,cx+t+0.5,cy-0.5,offset)) separator++;
    if(!darkAt(image,h,grid,cx+t+0.5,cy+7.5,offset)) separator++;
  }
  for(let t=0;t<=6;t++) {
    if(!darkAt(image,h,grid,cx-0.5,cy+t+0.5,offset)) separator++;
    if(!darkAt(image,h,grid,cx+7.5,cy+t+0.5,offset)) separator++;
  }
  return {core,separator};
}

function betterFinder(a,b) {
  if(!b) return true;
  if(a.core!==b.core) return a.core>b.core;
  if(a.separator!==b.separator) return a.separator>b.separator;
  const amag=Math.abs(a.x)+Math.abs(a.y), bmag=Math.abs(b.x)+Math.abs(b.y);
  return amag<bmag;
}

function searchFinderOffset(image,h,grid,cx,cy,radius=TRACKED_FINDER_SEARCH_PX) {
  let best=null;
  for(let dy=-radius;dy<=radius;dy++) for(let dx=-radius;dx<=radius;dx++) {
    const score=finderPatternScore(image,h,grid,cx,cy,{x:dx,y:dy});
    const candidate={x:dx,y:dy,...score}; if(betterFinder(candidate,best))best=candidate;
  }
  const coarse={...best};
  for(const fy of [-0.5,0,0.5]) for(const fx of [-0.5,0,0.5]) {
    const score=finderPatternScore(image,h,grid,cx,cy,{x:coarse.x+fx,y:coarse.y+fy});
    const candidate={x:coarse.x+fx,y:coarse.y+fy,...score}; if(betterFinder(candidate,best))best=candidate;
  }
  return best;
}

export function finderAnchorScore(image,h,grid,modules,offset={x:0,y:0}) {
  const corners=[[0,0],[modules-7,0],[0,modules-7]];
  return corners.reduce((sum,[cx,cy])=>sum+finderPatternScore(image,h,grid,cx,cy,offset).core,0);
}

// Kept as a public compatibility helper. Production sampling uses the stronger
// independent three-finder refinement below.
export function refineFinderAnchor(image,h,grid,modules,radius=TRACKED_FINDER_SEARCH_PX) {
  let best={x:0,y:0,score:-1};
  for(let dy=-radius;dy<=radius;dy++) for(let dx=-radius;dx<=radius;dx++) {
    const score=finderAnchorScore(image,h,grid,modules,{x:dx,y:dy});
    if(score>best.score)best={x:dx,y:dy,score};
  }
  return best;
}

function refineFinderCorners(image,h,grid,quad,modules) {
  const tl=searchFinderOffset(image,h,grid,0,0);
  const tr=searchFinderOffset(image,h,grid,modules-7,0);
  const bl=searchFinderOffset(image,h,grid,0,modules-7);
  const score=tl.core+tr.core+bl.core;
  if(score<TRACKED_FINDER_MIN_SCORE)return null;
  const q=shiftQuad(quad,0,0); if(!q)return null;
  const brOffset={x:tr.x+bl.x-tl.x,y:tr.y+bl.y-tl.y};
  const move=(p,o)=>({x:p.x+o.x,y:p.y+o.y});
  const refinedQuad={topLeft:move(q.topLeft,tl),topRight:move(q.topRight,tr),bottomLeft:move(q.bottomLeft,bl),bottomRight:move(q.bottomRight,brOffset)};
  const meanOffset={x:(tl.x+tr.x+bl.x)/3,y:(tl.y+tr.y+bl.y)/3};
  return {refinedQuad,score,separatorScore:tl.separator+tr.separator+bl.separator,offset:meanOffset,finderOffsets:{tl,tr,bl,br:brOffset}};
}

function alignmentIdeal(x,y) { return x===0 || x===4 || y===0 || y===4 || (x===2&&y===2); }
function alignmentScore(image,h,grid,mx,my,offset) {
  let score=0;
  for(let y=-2;y<=2;y++) for(let x=-2;x<=2;x++) if(darkAt(image,h,grid,mx+x+0.5,my+y+0.5,offset)===alignmentIdeal(x+2,y+2))score++;
  return score;
}

function alignmentCandidates(version) {
  const centers=alignmentPatternCenters(version); if(centers.length<2)return[];
  const out=[],last=centers[centers.length-1];
  for(const y of centers) for(const x of centers) {
    if((x===6&&y===6)||(x===6&&y===last)||(x===last&&y===6))continue;
    // Standard tables store the center module. alignmentScore() already walks
    // ±2 around that center; subtracting two here would shift every candidate.
    out.push({mx:x,my:y});
  }
  if(out.length<=TRACKED_MAX_ALIGNMENT_ANCHORS)return out;
  const selected=[],remaining=[...out].sort((a,b)=>(b.mx+b.my)-(a.mx+a.my)); selected.push(remaining.shift());
  while(selected.length<TRACKED_MAX_ALIGNMENT_ANCHORS&&remaining.length){let bestIndex=0,bestDistance=-1;for(let i=0;i<remaining.length;i++){const c=remaining[i],minDistance=Math.min(...selected.map(s=>(s.mx-c.mx)**2+(s.my-c.my)**2));if(minDistance>bestDistance){bestDistance=minDistance;bestIndex=i;}}selected.push(remaining.splice(bestIndex,1)[0]);}
  return selected;
}

export function findAlignmentResiduals(image,h,grid,modules,baseOffset={x:0,y:0}) {
  const version=versionFromModules(modules),anchors=[];
  for(const candidate of alignmentCandidates(version)) {
    let best={x:baseOffset.x,y:baseOffset.y,score:-1};
    for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
      const offset={x:baseOffset.x+dx,y:baseOffset.y+dy},score=alignmentScore(image,h,grid,candidate.mx,candidate.my,offset);
      if(score>best.score)best={...offset,score};
    }
    if(best.score>=TRACKED_ALIGNMENT_MIN_SCORE)anchors.push({mx:candidate.mx,my:candidate.my,dx:best.x,dy:best.y,score:best.score});
  }
  return anchors;
}

function correctionAt(mx,my,anchors) {
  if(!anchors?.length)return{x:0,y:0};
  let sumW=0.35,sumX=0,sumY=0;
  for(const anchor of anchors){const d2=(mx-anchor.mx)**2+(my-anchor.my)**2,w=1/(1+d2/400);sumW+=w;sumX+=anchor.dx*w;sumY+=anchor.dy*w;}
  return{x:sumX/sumW,y:sumY/sumW};
}

function sampleMatrix(image,h,grid,modules,anchors=[]) {
  const bits=new Uint8Array(modules*modules);let index=0;
  for(let y=0;y<modules;y++) for(let x=0;x<modules;x++) {
    const mx=x+0.5,my=y+0.5,correction=correctionAt(mx,my,anchors);
    bits[index++]=darkAt(image,h,grid,mx,my,correction)?1:0;
  }
  return{bits,modules,separation:grid.separation};
}

export function sampleTrackedQrCandidates(image,quad,modules) {
  if(!image?.data||!(image.width>0)||!(image.height>0)||!(modules>0))return null;
  const staleH=homographyForQr(modules,quad);if(!staleH)return null;
  const coarseGrid=buildLocalThresholdGrid(image,staleH,modules,{x:0,y:0});if(!coarseGrid)return null;
  const refined=refineFinderCorners(image,staleH,coarseGrid,quad,modules);if(!refined)return null;
  const h=homographyForQr(modules,refined.refinedQuad);if(!h)return null;
  const grid=buildLocalThresholdGrid(image,h,modules,{x:0,y:0});if(!grid)return null;
  const alignmentAnchors=findAlignmentResiduals(image,h,grid,modules,{x:0,y:0});
  const candidates=[];
  if(alignmentAnchors.length>=2)candidates.push({...sampleMatrix(image,h,grid,modules,alignmentAnchors),kind:'aligned',alignmentAnchors:alignmentAnchors.length});
  candidates.push({...sampleMatrix(image,h,grid,modules,[]),kind:'uniform',alignmentAnchors:0});
  return{candidates,bits:candidates[0].bits,modules,separation:grid.separation,anchorScore:refined.score,separatorScore:refined.separatorScore,alignmentAnchors:alignmentAnchors.length,offset:refined.offset,refinedQuad:refined.refinedQuad,finderOffsets:refined.finderOffsets};
}

export function sampleTrackedQr(image,quad,modules) {
  const sampled=sampleTrackedQrCandidates(image,quad,modules);
  return sampled?{bits:sampled.bits,modules:sampled.modules,separation:sampled.separation,anchorScore:sampled.anchorScore,separatorScore:sampled.separatorScore,alignmentAnchors:sampled.alignmentAnchors,refinedQuad:sampled.refinedQuad,offset:sampled.offset,finderOffsets:sampled.finderOffsets}:null;
}
