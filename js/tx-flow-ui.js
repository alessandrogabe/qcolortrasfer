// Normal TX is configuration-only. Keep QR stage measurable but off-page.
const shell=document.getElementById('txFullscreenShell');
const start=document.getElementById('startTx');
const toolbar=document.querySelector('#txView .tx-toolbar');
const note=document.querySelector('#txView .note');

if(!document.querySelector('link[data-tx-flow]')){
  const link=document.createElement('link');
  link.rel='stylesheet'; link.href='./tx-flow.css'; link.dataset.txFlow='1';
  document.head.appendChild(link);
}

if(shell&&!shell.classList.contains('tx-optical-overlay')){
  shell.style.position='fixed'; shell.style.left='-220vw'; shell.style.top='0';
  shell.style.visibility='hidden'; shell.style.pointerEvents='none';
}

if(start){start.textContent='START → QR';start.classList.add('tx-main-start');}

if(toolbar&&!document.querySelector('.tx-flow')){
  const flow=document.createElement('div'); flow.className='tx-flow';
  flow.setAttribute('aria-label','Procedura di invio');
  const labels=['SCEGLI FILE','CONFIGURA','START'];
  labels.forEach((label,i)=>{
    const step=document.createElement('span'); const badge=document.createElement('b');
    badge.textContent=String(i+1); step.append(badge,document.createTextNode(` ${label}`)); flow.appendChild(step);
    if(i<labels.length-1){const arrow=document.createElement('span');arrow.className='tx-flow-arrow';arrow.textContent='→';flow.appendChild(arrow);}
  });
  const result=document.createElement('span');result.className='tx-flow-result';result.textContent='QR A TUTTO SCHERMO + TRASMISSIONE';flow.appendChild(result);
  toolbar.before(flow);
}

if(note)note.textContent='COME FUNZIONA: questa schermata serve solo a preparare il trasferimento. START apre automaticamente la vista ottica e avvia il TX. Nella vista QR restano START, STOP, RESET ed ESCI; ESCI mette in pausa e torna alla configurazione.';
