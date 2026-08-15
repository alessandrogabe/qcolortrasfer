// qcolortrasfer OPTICAL MODEM RS on-air codec v3.3 (MIT).
//
// Version 2 of the standalone modem replaces short binary Hamming words with
// byte-symbol RS(255,223). 18 codewords are byte-interleaved across the 192x108
// field so local optical errors are spread among independent RS blocks.

import { encodeOpticalPacketV2 } from './protocol.js';
import {
  MODEM_GRID_W,MODEM_GRID_H,MODEM_QUIET,MODEM_RASTER_W,MODEM_RASTER_H,
  MODEM_STATES,MODEM_PALETTE,modemPayloadPositions
} from './optical-modem-codec.js';
import { RS_DATA_BYTES,RS_CODE_BYTES,rsEncodeInterleaved,rsDecodeInterleaved } from './optical-modem-rs.js';

export const MODEM_RS_VERSION=2;
export const MODEM_RS_PACKET_BYTES=RS_DATA_BYTES;          // 4014
export const MODEM_RS_QCT_OVERHEAD=28;
export const MODEM_RS_CHUNK_BYTES=MODEM_RS_PACKET_BYTES-MODEM_RS_QCT_OVERHEAD; // 3986
export const MODEM_RS_CODE_BYTES=RS_CODE_BYTES;            // 4590
export const MODEM_RS_CODE_BITS=MODEM_RS_CODE_BYTES*8;
export const MODEM_RS_CODE_CELLS=MODEM_RS_CODE_BYTES*4;    // 18360

const PAYLOAD=Object.freeze(modemPayloadPositions());
const BLACK=Object.freeze([0,0,0]),WHITE=Object.freeze([255,255,255]),NEUTRAL=Object.freeze([238,238,238]);
const MARKER_SIZE=11,MARKER_ZONE=15,CAL_W=5,CAL_H=4;
const CAL=Object.freeze([
  Object.freeze({x:25,y:2,kind:'color',state:0}),Object.freeze({x:32,y:2,kind:'color',state:1}),
  Object.freeze({x:39,y:2,kind:'color',state:2}),Object.freeze({x:46,y:2,kind:'color',state:3}),
  Object.freeze({x:53,y:2,kind:'black',state:-1}),Object.freeze({x:60,y:2,kind:'white',state:-1}),
]);
const PILOTS=Object.freeze([[64,36],[128,36],[64,72],[128,72]]);
if(MODEM_RS_CODE_CELLS>PAYLOAD.length)throw new Error('OPTICAL MODEM RS field does not fit payload cells');

function syncBit(i){let x=(Math.imul((i+1)>>>0,0x9e3779b1)^0xa6d3f05c)>>>0;x^=x>>>16;x=Math.imul(x,0x7feb352d)>>>0;x^=x>>>15;return(x>>>1)&1;}
function bitAt(bytes,index){return(bytes[index>>3]>>(7-(index&7)))&1;}
function controlBytes(streamId,symbolId){const out=new Uint8Array(8),v=new DataView(out.buffer);out[0]=0x4f;out[1]=0x4d;out[2]=MODEM_RS_VERSION;out[3]=MODEM_STATES;v.setUint16(4,streamId&0xffff);v.setUint16(6,symbolId&0xffff);return out;}

export function encodeRsModemPacket(meta,symbolId,payload){const packet=encodeOpticalPacketV2({...meta,visualStates:4},symbolId,payload);if(packet.length!==MODEM_RS_PACKET_BYTES)throw new Error(`OPTICAL MODEM RS packet ${packet.length} B != ${MODEM_RS_PACKET_BYTES} B`);return packet;}

export function packetToRsModemStates(packet){
  if(!(packet instanceof Uint8Array)||packet.length!==MODEM_RS_PACKET_BYTES)throw new Error(`OPTICAL MODEM RS packet must be ${MODEM_RS_PACKET_BYTES} B`);const coded=rsEncodeInterleaved(packet),states=new Uint8Array(PAYLOAD.length);let cell=0;
  for(let i=0;i<coded.length;i++){const b=coded[i];states[cell++]=(b>>6)&3;states[cell++]=(b>>4)&3;states[cell++]=(b>>2)&3;states[cell++]=b&3;}return states;
}

export function rsModemStatesToPacket(states){
  if(!(states instanceof Uint8Array)||states.length<MODEM_RS_CODE_CELLS)throw new Error('OPTICAL MODEM RS state field truncated');const coded=new Uint8Array(MODEM_RS_CODE_BYTES);let cell=0;
  for(let i=0;i<coded.length;i++){coded[i]=((states[cell++]&3)<<6)|((states[cell++]&3)<<4)|((states[cell++]&3)<<2)|(states[cell++]&3);}const decoded=rsDecodeInterleaved(coded);return{bytes:decoded.data,corrected:decoded.corrected};
}

function off(width,x,y){return(y*width+x)*4;}
function paintPixel(pixels,width,x,y,rgb){const o=off(width,x,y);pixels[o]=rgb[0];pixels[o+1]=rgb[1];pixels[o+2]=rgb[2];pixels[o+3]=255;}
function paintLogical(pixels,x,y,rgb){paintPixel(pixels,MODEM_RASTER_W,x+MODEM_QUIET,y+MODEM_QUIET,rgb);}
function markerDark(dx,dy){const d=Math.max(Math.abs(dx-5),Math.abs(dy-5));return d>=4||d<=1;}
function paintMarker(pixels,x0,y0){
  for(let y=y0;y<y0+MARKER_ZONE;y++)for(let x=x0;x<x0+MARKER_ZONE;x++)paintLogical(pixels,x,y,WHITE);const mx=x0===0?0:MODEM_GRID_W-MARKER_SIZE,my=y0===0?0:MODEM_GRID_H-MARKER_SIZE;
  for(let y=0;y<MARKER_SIZE;y++)for(let x=0;x<MARKER_SIZE;x++)paintLogical(pixels,mx+x,my+y,markerDark(x,y)?BLACK:WHITE);
}
function paintPilot(pixels,cx,cy){for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy));paintLogical(pixels,cx+dx,cy+dy,(d===2||d===0)?BLACK:WHITE);}}

export function createRsModemRaster(packet,{streamId=0,symbolId=0}={}){
  const states=packetToRsModemStates(packet),pixels=new Uint8ClampedArray(MODEM_RASTER_W*MODEM_RASTER_H*4);
  for(let y=0;y<MODEM_RASTER_H;y++)for(let x=0;x<MODEM_RASTER_W;x++)paintPixel(pixels,MODEM_RASTER_W,x,y,WHITE);
  for(let y=0;y<MODEM_GRID_H;y++)for(let x=0;x<MODEM_GRID_W;x++)paintLogical(pixels,x,y,NEUTRAL);
  paintMarker(pixels,0,0);paintMarker(pixels,MODEM_GRID_W-MARKER_ZONE,0);paintMarker(pixels,0,MODEM_GRID_H-MARKER_ZONE);paintMarker(pixels,MODEM_GRID_W-MARKER_ZONE,MODEM_GRID_H-MARKER_ZONE);
  for(let x=15;x<MODEM_GRID_W-15;x++){paintLogical(pixels,x,13,((x-15)&1)?WHITE:BLACK);paintLogical(pixels,x,MODEM_GRID_H-14,((x-15)&1)?BLACK:WHITE);}
  for(let y=15;y<MODEM_GRID_H-15;y++){paintLogical(pixels,13,y,((y-15)&1)?WHITE:BLACK);paintLogical(pixels,MODEM_GRID_W-14,y,((y-15)&1)?BLACK:WHITE);}
  for(const p of CAL){const rgb=p.kind==='color'?MODEM_PALETTE[p.state]:p.kind==='black'?BLACK:WHITE;for(let y=0;y<CAL_H;y++)for(let x=0;x<CAL_W;x++)paintLogical(pixels,p.x+x,p.y+y,rgb);}
  for(const y of [8,9])for(let x=64;x<128;x++)paintLogical(pixels,x,y,syncBit(x-64)?BLACK:WHITE);for(const[cx,cy]of PILOTS)paintPilot(pixels,cx,cy);
  const control=controlBytes(streamId,symbolId);for(let copy=0;copy<2;copy++)for(let i=0;i<64;i++)paintLogical(pixels,32+i,100+copy,bitAt(control,i)?BLACK:WHITE);
  for(let i=0;i<PAYLOAD.length;i++)paintLogical(pixels,PAYLOAD[i].x,PAYLOAD[i].y,i<MODEM_RS_CODE_CELLS?MODEM_PALETTE[states[i]&3]:NEUTRAL);
  return{pixels,width:MODEM_RASTER_W,height:MODEM_RASTER_H,gridWidth:MODEM_GRID_W,gridHeight:MODEM_GRID_H,states:MODEM_STATES,fec:'RS255/223'};
}
