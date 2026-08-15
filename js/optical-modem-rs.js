// qcolortrasfer OPTICAL MODEM Reed-Solomon FEC (MIT).
//
// Original implementation of systematic RS(255,191) over GF(256), primitive
// polynomial x^8+x^4+x^3+x^2+1 (0x11d). Each codeword has 64 parity bytes and
// corrects up to 32 arbitrary byte-symbol errors. Eighteen codewords are
// interleaved across the optical field so local display/camera errors are spread
// across independent RS blocks. Decoder uses Berlekamp-Massey for the locator,
// Chien search for positions and a small GF Vandermonde solve for magnitudes.
// No third-party source is incorporated.

export const RS_N=255;
export const RS_K=191;
export const RS_PARITY=RS_N-RS_K;
export const RS_T=RS_PARITY/2;
export const RS_BLOCKS=18;
export const RS_DATA_BYTES=RS_K*RS_BLOCKS;      // 3438
export const RS_CODE_BYTES=RS_N*RS_BLOCKS;      // 4590

const EXP=new Uint16Array(512),LOG=new Int16Array(256);LOG.fill(-1);
let gx=1;for(let i=0;i<255;i++){EXP[i]=gx;LOG[gx]=i;gx<<=1;if(gx&0x100)gx^=0x11d;}for(let i=255;i<512;i++)EXP[i]=EXP[i-255];

export function gfMul(a,b){return!a||!b?0:EXP[LOG[a]+LOG[b]];}
function gfDiv(a,b){if(!b)throw new Error('RS division by zero');return!a?0:EXP[(LOG[a]-LOG[b]+255)%255];}
function gfPow(a,n){if(n===0)return 1;if(!a)return 0;return EXP[((LOG[a]*n)%255+255)%255];}

function polyMulHigh(a,b){const out=new Uint8Array(a.length+b.length-1);for(let i=0;i<a.length;i++)if(a[i])for(let j=0;j<b.length;j++)if(b[j])out[i+j]^=gfMul(a[i],b[j]);return out;}
function buildGenerator(){let g=Uint8Array.of(1);for(let i=0;i<RS_PARITY;i++)g=polyMulHigh(g,Uint8Array.of(1,EXP[i]));return g;}
const GENERATOR=buildGenerator();

function polyEvalHigh(poly,x){let y=poly[0];for(let i=1;i<poly.length;i++)y=gfMul(y,x)^poly[i];return y;}
function polyEvalLow(poly,x){let y=0;for(let i=poly.length-1;i>=0;i--)y=gfMul(y,x)^poly[i];return y;}
function syndromes(code){const out=new Uint8Array(RS_PARITY);for(let i=0;i<RS_PARITY;i++)out[i]=polyEvalHigh(code,EXP[i]);return out;}
function anyNonZero(a){for(const v of a)if(v)return true;return false;}

export function rsEncodeBlock(data){
  if(!(data instanceof Uint8Array)||data.length!==RS_K)throw new Error(`RS data block must be ${RS_K} bytes`);
  const work=new Uint8Array(RS_N);work.set(data);
  for(let i=0;i<RS_K;i++){const coef=work[i];if(!coef)continue;for(let j=1;j<GENERATOR.length;j++)work[i+j]^=gfMul(GENERATOR[j],coef);}
  const out=new Uint8Array(RS_N);out.set(data);out.set(work.subarray(RS_K),RS_K);return out;
}

function berlekampMassey(synd){
  const C=new Uint8Array(RS_PARITY+1),B=new Uint8Array(RS_PARITY+1);C[0]=1;B[0]=1;let L=0,m=1,b=1;
  for(let n=0;n<RS_PARITY;n++){
    let d=synd[n];for(let i=1;i<=L;i++)d^=gfMul(C[i],synd[n-i]);
    if(!d){m++;continue;}
    const T=C.slice(),coef=gfDiv(d,b);for(let i=0;i+m<C.length;i++)if(B[i])C[i+m]^=gfMul(coef,B[i]);
    if(2*L<=n){L=n+1-L;B.set(T);b=d;m=1;}else m++;
  }
  return{locator:C.slice(0,L+1),degree:L};
}

function findErrorPositions(locator,degree,n){
  const positions=[],powers=[];
  for(let pos=0;pos<n;pos++){
    const power=(n-1-pos)%255,invX=power?EXP[(255-power)%255]:1;
    if(polyEvalLow(locator,invX)===0){positions.push(pos);powers.push(power?EXP[power]:1);}
  }
  return positions.length===degree?{positions,powers}:null;
}

function solveVandermonde(powers,synd){
  const n=powers.length,A=Array.from({length:n},(_,r)=>{const row=new Uint8Array(n+1);for(let c=0;c<n;c++)row[c]=gfPow(powers[c],r);row[n]=synd[r];return row;});
  for(let col=0;col<n;col++){
    let pivot=col;while(pivot<n&&!A[pivot][col])pivot++;if(pivot===n)return null;if(pivot!==col)[A[col],A[pivot]]=[A[pivot],A[col]];
    const inv=gfDiv(1,A[col][col]);for(let j=col;j<=n;j++)A[col][j]=gfMul(A[col][j],inv);
    for(let r=0;r<n;r++){if(r===col)continue;const f=A[r][col];if(!f)continue;for(let j=col;j<=n;j++)A[r][j]^=gfMul(f,A[col][j]);}
  }
  return Uint8Array.from(A.map(row=>row[n]));
}

export function rsDecodeBlock(code){
  if(!(code instanceof Uint8Array)||code.length!==RS_N)throw new Error(`RS code block must be ${RS_N} bytes`);const out=code.slice(),synd=syndromes(out);if(!anyNonZero(synd))return{data:out.slice(0,RS_K),corrected:0};
  const{locator,degree}=berlekampMassey(synd);if(!degree||degree>RS_T)throw new Error(`RS uncorrectable locator degree ${degree}`);
  const found=findErrorPositions(locator,degree,RS_N);if(!found)throw new Error(`RS error position search failed (locator degree ${degree})`);const magnitudes=solveVandermonde(found.powers,synd);if(!magnitudes)throw new Error('RS magnitude solve failed');
  for(let i=0;i<found.positions.length;i++)out[found.positions[i]]^=magnitudes[i];if(anyNonZero(syndromes(out)))throw new Error('RS residual syndrome after correction');
  return{data:out.slice(0,RS_K),corrected:found.positions.length};
}

export function rsEncodeInterleaved(data){
  if(!(data instanceof Uint8Array)||data.length!==RS_DATA_BYTES)throw new Error(`RS modem data must be ${RS_DATA_BYTES} bytes`);const blocks=[];for(let b=0;b<RS_BLOCKS;b++)blocks.push(rsEncodeBlock(data.slice(b*RS_K,(b+1)*RS_K)));
  const out=new Uint8Array(RS_CODE_BYTES);let p=0;for(let column=0;column<RS_N;column++)for(let b=0;b<RS_BLOCKS;b++)out[p++]=blocks[b][column];return out;
}

export function rsDecodeInterleaved(code){
  if(!(code instanceof Uint8Array)||code.length<RS_CODE_BYTES)throw new Error(`RS modem code must contain ${RS_CODE_BYTES} bytes`);const blocks=Array.from({length:RS_BLOCKS},()=>new Uint8Array(RS_N));let p=0;
  for(let column=0;column<RS_N;column++)for(let b=0;b<RS_BLOCKS;b++)blocks[b][column]=code[p++];
  const data=new Uint8Array(RS_DATA_BYTES);let corrected=0;for(let b=0;b<RS_BLOCKS;b++){let d;try{d=rsDecodeBlock(blocks[b]);}catch(error){throw new Error(`RS block ${b}: ${error?.message||error}`);}data.set(d.data,b*RS_K);corrected+=d.corrected;}return{data,corrected};
}
