import test from 'node:test';
import assert from 'node:assert/strict';
import { FountainEncoder, FountainDecoder, dlog, indicesForSymbol, solitonCdf, splitmix32 } from '../js/fountain.js';

test('Decimen-compatible deterministic log vectors stay pinned',()=>{assert.equal(dlog(1),0);assert.equal(dlog(1.5),0.4054651081081644);assert.equal(dlog(10),2.3025850929940455);});
test('robust-soliton CDF is monotonic and terminates at one',()=>{for(const k of [1,2,17,179,866]){const cdf=solitonCdf(k);assert.equal(cdf.length,k);assert.equal(cdf[k-1],1);for(let i=1;i<k;i++)assert.ok(cdf[i]>=cdf[i-1]);}});
test('recorded Decimen v0.3 frame subsets are preserved',()=>{assert.deepEqual(indicesForSymbol(0,17,4242),[3,14]);assert.deepEqual(indicesForSymbol(1,17,4242),[12,0]);assert.deepEqual(indicesForSymbol(41,179,4242),[28,132,88]);});
function payload(length){return Uint8Array.from({length},(_,i)=>(i*37+(i>>8)*11)&255);}
function roundTrip(length,chunk,sessionId,dropRate=0,reverse=false){const input=payload(length);const enc=new FountainEncoder(input,chunk,sessionId);const frames=[];const rnd=splitmix32(sessionId^0x51f15e);const ceiling=enc.sourceCount*5+500;for(let seq=0;seq<ceiling;seq++){if(rnd()*2**-32>=dropRate)frames.push([seq,enc.symbol(seq).data]);}if(reverse)frames.reverse();const dec=new FountainDecoder(enc.sourceCount,chunk,length,sessionId);for(const [seq,data] of frames){dec.addSymbol(seq,data);if(dec.complete)break;}return{input,enc,dec};}
test('30% optical loss costs time, never correctness',()=>{const{input,enc,dec}=roundTrip(256*1024,512,0x12345678,.30);assert.equal(dec.complete,true);assert.deepEqual(dec.reconstruct(),input);assert.ok(dec.framesNew/enc.sourceCount<1.8);});
test('frames can arrive out of order',()=>{const{input,dec}=roundTrip(100000,512,77,0,true);assert.equal(dec.complete,true);assert.deepEqual(dec.reconstruct(),input);});
test('camera rereads of the same QR are ignored safely',()=>{const input=payload(40000);const enc=new FountainEncoder(input,512,31);const dec=new FountainDecoder(enc.sourceCount,512,input.length,31);let seq=0;while(!dec.complete&&seq<enc.sourceCount*5+500){const frame=enc.symbol(seq).data;assert.equal(dec.addSymbol(seq,frame),true);assert.equal(dec.addSymbol(seq,frame),false);seq++;}assert.equal(dec.complete,true);assert.ok(dec.framesDup>0);assert.deepEqual(dec.reconstruct(),input);});
