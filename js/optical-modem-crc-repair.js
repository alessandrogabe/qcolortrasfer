// qcolortrasfer OPTICAL MODEM CRC-guided Hamming list repair (MIT).
//
// Hamming(15,11) corrects one bit per word but silently miscorrects a two-bit
// word. At low optical BER this leaves only a few bad words in an otherwise
// valid frame. The Hamming syndrome constrains a double error to a^b=syndrome;
// per-cell classifier margins let us compare the optical cost of the ordinary
// single-bit explanation against each legal two-bit explanation. QCT2 CRC32 is
// the final oracle. No payload/on-air format change is required.

import { decodeOpticalPacket } from './protocol.js';
import { MODEM_CODE_BITS, MODEM_FEC_PERMUTATION } from './optical-modem-codec.js';

const DATA_POSITIONS=Object.freeze([3,5,6,7,9,10,11,12,13,14,15]);
const WORD_BITS=15,DATA_BITS=11,MAX_DOUBLE_WORDS=20;

function setPacketBit(bytes,index,value){if(index>=bytes.length*8)return;const mask=1<<(7-(index&7));if(value)bytes[index>>3]|=mask;else bytes[index>>3]&=~mask;}
function unpackObserved(states,cellConfidence){
  const scrambled=new Uint8Array(MODEM_CODE_BITS),scrambledConfidence=new Float32Array(MODEM_CODE_BITS),cells=Math.min(states.length,Math.ceil(MODEM_CODE_BITS/2));
  for(let i=0;i<cells;i++){
    const s=states[i]&3,j=i*2,c=Math.max(0,Number(cellConfidence?.[i])||0);
    if(j<MODEM_CODE_BITS){scrambled[j]=(s>>1)&1;scrambledConfidence[j]=c;}
    if(j+1<MODEM_CODE_BITS){scrambled[j+1]=s&1;scrambledConfidence[j+1]=c;}
  }
  const coded=new Uint8Array(MODEM_CODE_BITS),conf=new Float32Array(MODEM_CODE_BITS);
  for(let i=0;i<MODEM_CODE_BITS;i++){const j=(i*MODEM_FEC_PERMUTATION)%MODEM_CODE_BITS;coded[i]=scrambled[j];conf[i]=scrambledConfidence[j];}
  return{coded,conf};
}
function syndromeOf(coded,offset){let syndrome=0;for(let p=1;p<=15;p++)if(coded[offset+p-1])syndrome^=p;return syndrome;}
function pairOptions(syndrome){const out=[];for(let a=1;a<=15;a++)for(let b=a+1;b<=15;b++)if((a^b)===syndrome)out.push([a,b]);return out;}
function pairCost(conf,offset,pair){return conf[offset+pair[0]-1]+conf[offset+pair[1]-1];}
function softWordScore(conf,offset,syndrome,pairs){
  const singleCost=conf[offset+syndrome-1];let bestPairCost=Infinity,bestPair=null;
  for(const pair of pairs){const c=pairCost(conf,offset,pair);if(c<bestPairCost){bestPairCost=c;bestPair=pair;}}
  // Negative strongly favours a double-error explanation over the ordinary
  // Hamming single-bit correction. A tiny complexity prior prevents noisy ties
  // from promoting arbitrary pairs when margins are equal.
  return{singleCost,bestPairCost,bestPair,doubleScore:(bestPairCost+.002)-singleCost};
}
function patchWord(bytes,coded,word,pair){
  const offset=word*WORD_BITS,bits=new Uint8Array(16);for(let p=1;p<=15;p++)bits[p]=coded[offset+p-1];if(pair){bits[pair[0]]^=1;bits[pair[1]]^=1;}
  let dst=word*DATA_BITS;for(const p of DATA_POSITIONS)setPacketBit(bytes,dst++,bits[p]);
}
function validPacket(bytes){try{return decodeOpticalPacket(bytes);}catch{return null;}}

export function repairModemPacketWithCrc(states,cellConfidence,baselineBytes,{maxDoubleWords=MAX_DOUBLE_WORDS}={}){
  if(!states||!baselineBytes)return null;const{coded,conf}=unpackObserved(states,cellConfidence),words=Math.ceil(MODEM_CODE_BITS/WORD_BITS),suspects=[];
  for(let w=0;w<words;w++){
    const offset=w*WORD_BITS,syndrome=syndromeOf(coded,offset);if(!syndrome)continue;const pairs=pairOptions(syndrome);if(!pairs.length)continue;
    suspects.push({word:w,syndrome,pairs,...softWordScore(conf,offset,syndrome,pairs)});
  }
  if(!suspects.length)return null;let trials=0;

  // One double-error word: exhaustive over every syndrome word is cheap and
  // guarantees recovery regardless of soft ranking.
  for(const suspect of suspects)for(const pair of suspect.pairs){trials++;const candidate=baselineBytes.slice();patchWord(candidate,coded,suspect.word,pair);const packet=validPacket(candidate);if(packet)return{bytes:candidate,packet,listWords:1,listTrials:trials,suspectCount:suspects.length};}

  // Two bad words: rank by pair-vs-single likelihood, not by generic low margin.
  // This keeps the CRC search bounded while targeting actual Hamming ambiguity.
  const ranked=suspects.slice().sort((a,b)=>a.doubleScore-b.doubleScore).slice(0,Math.max(2,maxDoubleWords));
  for(let i=0;i<ranked.length;i++)for(let j=i+1;j<ranked.length;j++)for(const pa of ranked[i].pairs)for(const pb of ranked[j].pairs){
    trials++;const candidate=baselineBytes.slice();patchWord(candidate,coded,ranked[i].word,pa);patchWord(candidate,coded,ranked[j].word,pb);const packet=validPacket(candidate);if(packet)return{bytes:candidate,packet,listWords:2,listTrials:trials,suspectCount:suspects.length};
  }
  return{failed:true,listWords:0,listTrials:trials,suspectCount:suspects.length};
}
