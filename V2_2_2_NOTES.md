# v2.2.2 — START apre direttamente la vista ottica

La schermata TX normale è solo configurazione: file, payload, profilo, fps, griglia, START, stato e telemetria. La griglia QR non viene più mostrata nel layout normale.

Premendo START con un file selezionato, `tx-optical-view.js` entra prima nella vista ottica dedicata e poi lascia proseguire il normale handler TX di `app.js`, che avvia la trasmissione. La vista ottica contiene soltanto i QR e la barra START / STOP / RESET / ESCI.

ESCI mette prima in pausa il TX tramite il controllo STOP esistente e poi torna alla configurazione. Nessuna trasmissione rimane attiva dietro la pagina.

Il contenitore ottico resta parcheggiato fuori viewport quando inattivo, con dimensioni valide per il prerender. Questo evita il grande riquadro bianco senza costringere il motore a generare i QR da un elemento `display:none` di dimensione zero.
