// qcolortrasfer OPTICAL MODEM CRC-guided Hamming list repair (MIT).
//
// Hamming(15,11) corrects one bit per word but silently miscorrects a two-bit
// word. At low optical BER this leaves only one or two bad words in an otherwise
// valid frame. We exploit two facts already present in the format:
//   1) the Hamming syndrome constrains a double error to pairs a^b=syndrome;
//   2) QCT2 has CRC32, which is an unambiguous final oracle.
// Cell classifier margins rank the most likely multi-error words. No payload or
// on-air format change is required.

import { decodeOpticalPacket } from './protocol.js';
import { MODEM_CODE_BITS, MODEM_FEC_PERMUTATION } from './optical-modem-codec.js';

const DATA_POSITIONS=Object.freeze([3,5,6,7,9,10,11,12,13,14,15]);
const WORD_BITS=15,DATA_BITS=11,MAX_DOUBLE_WORDS=20;

function setPacketBit(bytes,index,value){if(index>=bytes.length*8)return;const mask=1<<(7-(index&7));if(value)bytes[index>>3]|=mask;else bytes[index>>3]&=~mask;}
function observedBits(states){
  const scrambled=new Uint8Array(MODEM_CODE_BITS),confidence=new Float32Array(MODEM_CODE_BITS);return{scrambled,confidence};
}

function unpackObserved(states,cellConfidence){
  const{scrambled,confidence}=observedBits(states);const cells=Math.min(states.length,Math.ceil(MODEM_CODE_BITS/2));
  for(let i=0;i<cells;i++){const s=states[i]&3,j=i*2,c=Math.max(0,Number(cellConfidence?.[i])||0);if(j<MODEM_CODE_BITS){scrambled[j]=(s>>1)&1;confidence[j]=c;}if(j+1<MODEM_CODE_BITS){scrambled[j+1]=s&1;confidence[j+1]=c;}}
  const coded=new Uint8Array(MODEM_CODE_BITS),conf=new Float32Array(MODEM_CODE_BITS);
  for(let i=0;i<MODEM_CODE_BITS;i++){const j=(i*MODEM_FEC_PERMUTATION)%MODEM_CODE_BITS;coded[i]=scrambled[j];conf[i]=confidence[j];}
  return{coded,conf};
}
function syndromeOf(coded,offset){let syndrome=0;for(let p=1;p<=15;p++)if(coded[offset+p-1])syndrome^=p;return syndrome;}
function pairOptions(syndrome){const out=[];for(let a=1;a<=15;a++)for(let b=a+1;b<=15;b++)if((a^b)===syndrome)out.push([a,b]);return out;}
function wordConfidence(conf,offset){const values=[];for(let p=0;p<15;p++)values.push(conf[offset+p]);values.sort((a,b)=>a-b);return(values[0]||0)+(values[1]||0)+(values[2]||0)*.25;}
function patchWord(bytes,coded,word,pair){
  const offset=word*WORD_BITS,bits=new Uint8Array(16);for(let p=1;p<=15;p++)bits[p]=coded[offset+p-1];if(pair){bits[pair[0]]^=1;bits[pair[1]]^=1;}
  let dst=word*DATA_BITS;for(const p of DATA_POSITIONS)setPacketBit(bytes,dst++,bits[p]);
}
function validPacket(bytes){try{return decodeOpticalPacket(bytes);}catch{return null;}}

export function repairModemPacketWithCrc(states,cellConfidence,baselineBytes,{maxDoubleWords=MAX_DOUBLE_WORDS}={}){
  if(!states||!baselineBytes)return null;const{coded,conf}=unpackObserved(states,cellConfidence),words=Math.ceil(MODEM_CODE_BITS/WORD_BITS),suspects=[];
  for(let w=0;w<words;w++){const offset=w*WORD_BITS,s=syndromeOf(coded,offset);if(!s)continue;const pairs=pairOptions(s);if(!pairs.length)continue;suspects.push({word:w,syndrome:s,pairs,confidence:wordConfidence(conf,offset)});}
  if(!suspects.length)return null;

  // One double-error word: exhaustive over every syndrome word is cheap.
  for(const suspect of suspects)for(const pair of suspect.pairs){const candidate=baselineBytes.slice();patchWord(candidate,coded,suspect.word,pair);const packet=validPacket(candidate);if(packet)return{bytes:candidate,packet,listWords:1,listTrials:1,suspectCount:suspects.length};}

  // Two double-error words are the common next case at low BER. Restrict the
  // combinatorial pass to the least-confident words, but try every legal pair
  // inside those words. Classifier margin makes this ranking optical, not random.
  const ranked=suspects.slice().sort((a,b)=>a.confidence-b.confidence).slice(0,Math.max(2,maxDoubleWords));let trials=0;
  for(let i=0;i<ranked.length;i++)for(let j=i+1;j<ranked.length;j++)for(const pa of ranked[i].pairs)for(const pb of ranked[j].pairs){
    trials++;const candidate=baselineBytes.slice();patchWord(candidate,coded,ranked[i].word,pa);patchWord(candidate,coded,ranked[j].word,pb);const packet=validPacket(candidate);if(packet)return{bytes:candidate,packet,listWords:2,listTrials:trials,suspectCount:suspects.length};
  }
  return{failed:true,listWords:0,listTrials:trials,suspectCount:suspects.length};
}
