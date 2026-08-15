import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeModemDisplayLayout,
  fitModemRaster,
  isDesktopModemViewport,
  MODEM_DESKTOP_MAX_CSS_WIDTH,
  MODEM_DESKTOP_MAX_CSS_HEIGHT,
  MODEM_DESKTOP_MAX_CELL_CSS,
} from '../js/optical-modem-layout.js';
import { MODEM_RASTER_W, MODEM_RASTER_H } from '../js/optical-modem-codec.js';

function layout(width,height,dpr=1){return computeModemDisplayLayout({width,height,dpr,rasterWidth:MODEM_RASTER_W,rasterHeight:MODEM_RASTER_H});}

test('desktop modem no longer expands to the full 1920x1080 optical stage',()=>{
  const l=layout(1920,1000,1);
  assert.equal(l.desktop,true);
  assert.equal(l.rotated,false);
  assert.ok(l.cssWidth<=MODEM_DESKTOP_MAX_CSS_WIDTH);
  assert.ok(l.cssHeight<=MODEM_DESKTOP_MAX_CSS_HEIGHT);
  assert.ok(l.scale<=MODEM_DESKTOP_MAX_CELL_CSS);
  assert.ok(l.cssWidth<1920*.7,'desktop field should leave substantial camera-friendly surround');
});

test('ordinary laptop keeps the modem entirely inside a compact centered raster',()=>{
  const l=layout(1366,680,1);
  assert.equal(l.desktop,true);
  assert.equal(l.rotated,false);
  assert.ok(l.cssWidth<=1040&&l.cssHeight<=680);
  assert.ok(l.cssWidth<=1366&&l.cssHeight<=680);
  assert.ok(l.scale>=4,'laptop cells should still be optically large');
});

test('high-DPI desktop caps CSS cell size while preserving integer backing scale',()=>{
  const l=layout(1800,950,2);
  assert.equal(l.desktop,true);
  assert.equal(l.rotated,false);
  assert.ok(l.scale<=MODEM_DESKTOP_MAX_CELL_CSS*2);
  assert.ok(l.cssWidth<=MODEM_DESKTOP_MAX_CSS_WIDTH);
  assert.equal(Number.isInteger(l.scale),true);
});

test('phone portrait still uses the long axis instead of desktop compact policy',()=>{
  const l=layout(390,760,3);
  assert.equal(l.desktop,false);
  assert.equal(l.rotated,true);
  assert.ok(l.cssWidth<=390+1e-6&&l.cssHeight<=760+1e-6);
  assert.ok(l.cssWidth>300,'phone should still use most of the available width');
});

test('desktop classification requires both sufficient width and height',()=>{
  assert.equal(isDesktopModemViewport(1200,700),true);
  assert.equal(isDesktopModemViewport(800,700),false);
  assert.equal(isDesktopModemViewport(1200,430),false);
});

test('fixed raster fitting never exceeds desktop caps',()=>{
  const f=fitModemRaster({width:2560,height:1360,dpr:1,rasterWidth:MODEM_RASTER_W,rasterHeight:MODEM_RASTER_H});
  assert.equal(f.desktop,true);
  assert.ok(f.cssWidth<=MODEM_DESKTOP_MAX_CSS_WIDTH);
  assert.ok(f.cssHeight<=MODEM_DESKTOP_MAX_CSS_HEIGHT);
});
