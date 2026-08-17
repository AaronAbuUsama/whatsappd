/**
 * The pairing and first-sync screen, as one file. Emitted by `index.ts`, served
 * from 127.0.0.1, updated over SSE. Self-contained: inline CSS and JS, no
 * network, no CDN, no build step.
 *
 * The screen exists because a static QR cannot be told anything, and the defect
 * it fixes is "it says it is syncing but nothing happens" — a first sync takes
 * minutes and the only honest answer is to show the history arriving.
 *
 * The direction contract below is emitted as the first child of `<body>`, where
 * it survives into the served page and can be audited against the render.
 */

/** One QR matrix, as a single SVG path. Crisp at any size, one DOM node. */
export function qrPath(isDark: (r: number, c: number) => boolean, n: number): string {
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // Runs of dark modules merge into one rect so the path stays small.
      if (!isDark(r, c)) continue;
      let run = 1;
      while (c + run < n && isDark(r, c + run)) run++;
      d += `M${c} ${r}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return d;
}

const CSS = String.raw`
:root{
  --ground:#0B0705; --glow:#2A0D05; --ink:#F6EFE4; --ink-2:#CBA98D;
  --safelight:#FF6A18; --paper:#F4EDE2; --paper-ink:#17100B; --rebate:#050303;
  --stop:#FF3B30; --line:rgba(255,106,24,.22);
  --cell:rgba(255,106,24,.12); --cell-lit:var(--safelight);
}
@media (prefers-color-scheme:light){
  :root{
    --ground:#EFE6D8; --glow:#E4D3BC; --ink:#241004; --ink-2:#6B4630;
    --safelight:#B4430A; --paper:#FFFCF7; --paper-ink:#17100B; --rebate:#2A1206;
    --stop:#B3261E; --line:rgba(180,67,10,.28);
    --cell:rgba(180,67,10,.14); --cell-lit:var(--safelight);
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;display:grid;place-items:center;padding:2.5rem 1.25rem;
  background:var(--ground);color:var(--ink);
  font:400 15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(60% 45% at 50% 8%,var(--glow) 0%,transparent 70%);
}
.wrap{width:100%;max-width:33rem;display:grid;gap:1.75rem;justify-items:center}

h1{margin:0;font-size:1.5rem;line-height:1.2;font-weight:600;letter-spacing:-.02em;text-align:center}
.path{margin:.5rem 0 0;color:var(--ink-2);font-size:.875rem;text-align:center}
.path b{color:var(--ink);font-weight:500;white-space:nowrap}
.path span{opacity:.5;padding:0 .3em}

/* The print: paper in a photographic rebate. */
.print{
  position:relative;width:min(19rem,72vw);aspect-ratio:1;border-radius:3px;
  background:var(--rebate);padding:.75rem;
  box-shadow:0 1.25rem 2.5rem -1rem rgba(0,0,0,.65),0 0 0 1px var(--line);
}
.sheet{
  position:relative;width:100%;height:100%;background:var(--paper);border-radius:1px;
  display:grid;place-items:center;overflow:hidden;
  /* the develop: paper arrives underexposed and comes up */
  filter:brightness(var(--dev,1));transition:filter 1.1s cubic-bezier(.16,1,.3,1);
}
.sheet.developing{--dev:.28}
svg.qr{width:86%;height:86%;display:block}
svg.qr path{fill:var(--paper-ink)}

/* Rotation clock: a bar that depletes over the code's own lifetime. Deliberately
   NOT a ring around the print — a circle inscribed in a square crosses the code,
   and nothing may sit on top of a QR that has to survive a phone camera. */
.life{width:min(19rem,72vw);height:2px;background:var(--line);border-radius:2px;
  overflow:hidden;opacity:0;transition:opacity .4s ease}
body[data-view="qr"] .life{opacity:1}
.life i{display:block;height:100%;background:var(--safelight);
  transform-origin:left center;transition:transform .95s linear}

/* The print holds the QR and nothing else, so once the code is scanned it goes
   away entirely rather than standing there empty. There is no honest picture of
   "how far through" a history sync is — WhatsApp never sends a total, so any
   fill level is invented. An earlier version lit a grid from chats/chatsTotal
   where chatsTotal was assigned from the same counter, so it read 100% on the
   first batch and never moved again. A confident wrong gauge is worse than no
   gauge, and an empty slab where a picture was is worse than either: it reads as
   a broken image rather than an absent one. The counts below carry the state. */
.stage{display:grid;gap:.75rem;justify-items:center}
body[data-tone="stop"] .stage,body[data-view="sheet"] .stage{display:none}

/* Status */
.status{display:flex;align-items:center;gap:.6rem;font-size:.9375rem;min-height:1.5rem}
.mark{flex:none;width:1.125rem;height:1.125rem;color:var(--safelight)}
.mark.stop{color:var(--stop)}
.pulse{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.detail{color:var(--ink-2);font-size:.8125rem;text-align:center;max-width:38ch;margin:0}

/* Counters develop in: dark until they carry data. */
.counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;
  width:100%;background:var(--line);border:1px solid var(--line);border-radius:4px;overflow:hidden}
.counts div{background:var(--ground);padding:.8rem .5rem;text-align:center}
/* Fade the contents, never the cell: an opaque cell is what hides the container's
   rule colour behind it, and fading the cell lets that colour bleed through. */
.counts dt,.counts dd{opacity:.34;transition:opacity .6s ease}
.counts div.has dt,.counts div.has dd{opacity:1}
.counts dt{margin:0 0 .3rem;font-size:.6875rem;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-2)}
.counts dd{margin:0;font-variant-numeric:tabular-nums;font-size:1.375rem;font-weight:600;
  letter-spacing:-.02em;line-height:1}
.counts dd.sm{font-size:.9375rem;font-weight:500;padding-top:.35rem}

/* Which kind of history is arriving. WhatsApp types every batch, and the kinds
   mean different things: recent is the short slice every link gets, full only
   appears when the pairing asked for it, and on demand answers requestHistory.
   Showing them separates "still syncing" from "that is all there is". */
.kinds{display:flex;flex-wrap:wrap;gap:.35rem;justify-content:center;min-height:1.5rem}
.kinds b{font-weight:500;font-size:.6875rem;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-2);border:1px solid var(--line);border-radius:999px;padding:.2rem .55rem;
  opacity:.38;transition:opacity .5s ease,color .5s ease}
.kinds b.has{opacity:1;color:var(--safelight)}
.kinds b i{font-style:normal;font-variant-numeric:tabular-nums;color:var(--ink)}

.fallback{color:var(--ink-2);font-size:.8125rem;text-align:center;display:none}
body[data-view="qr"] .fallback{display:block}
.fallback code{color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const JS = String.raw`
const $=s=>document.querySelector(s);
let deadline=0,tick=null;

function clock(expiresAt,lifetime){
  clearInterval(tick); deadline=expiresAt;
  const run=$("#life"); if(!run) return;
  const paint=()=>{
    const left=Math.max(0,deadline-Date.now());
    run.style.transform="scaleX("+(left/lifetime).toFixed(4)+")";
    if(left<=0) clearInterval(tick);
  };
  paint(); tick=setInterval(paint,950);
}

function counts(s){
  const set=(sel,val,has)=>{const el=$(sel);el.textContent=val;
    el.parentElement.classList.toggle("has",Boolean(has))};
  set("#chats",s.chats.toLocaleString(),s.chats>0);
  set("#msgs",s.messages.toLocaleString(),s.messages>0);
  set("#oldest",s.oldest?new Date(s.oldest).toLocaleDateString(undefined,
    {year:"numeric",month:"short",day:"numeric"}):"—",s.oldest);
  for(const [kind,n] of Object.entries(s.kinds||{})){
    const el=document.getElementById("k-"+kind); if(!el) continue;
    el.querySelector("i").textContent=n; el.classList.toggle("has",n>0);
  }
}

function render(s){
  document.body.dataset.view=s.view; document.body.dataset.tone=s.tone;
  $("#title").textContent=s.title;
  $("#detail").textContent=s.detail||"";
  $("#label").textContent=s.label;
  $(".mark").classList.toggle("stop",s.tone==="stop");
  $(".mark").classList.toggle("pulse",s.tone==="working");
  $("#markUse").setAttribute("href","#i-"+s.icon);
  $(".guide").hidden=s.view!=="qr";
  if(s.qr){ $(".qr path").setAttribute("d",s.qr.d);
    $(".qr").setAttribute("viewBox","-2 -2 "+(s.qr.n+4)+" "+(s.qr.n+4));
    $(".sheet").classList.remove("developing");
    clock(s.qr.expiresAt,s.qr.lifetime); }
  if(s.view==="sheet") clearInterval(tick);
  if(s.lastBatchAt!==quietSince) quiet(s.lastBatchAt);
  counts(s);
}

// A full sync has no completion signal. A progress of 100 closes the RECENT
// phase and is what puts the session online, but FULL batches keep arriving
// after that with nothing marking the last one. isLatest is not it either:
// upstream computes it from processedHistoryMessages being empty, so it is
// true on the FIRST payload, not the last.
//
// So the page reports the one thing actually observed — how long since anything
// arrived — and says plainly that quiet is not the same as finished.
let quietSince=0,quietTick=null;
function quiet(since){
  quietSince=since; clearInterval(quietTick);
  const el=$("#quiet"); if(!el) return;
  const paint=()=>{
    if(!quietSince||document.body.dataset.view!=="sheet"){el.textContent="";return}
    const s=Math.floor((Date.now()-quietSince)/1000);
    el.textContent=s<15?"":"No new history for "+(s<60?s+"s":Math.floor(s/60)+"m "+(s%60)+"s")+
      ". A full sync has no completion signal, so this is quiet — not confirmed finished.";
  };
  paint(); quietTick=setInterval(paint,1000);
}

const es=new EventSource("/events");
es.onmessage=e=>render(JSON.parse(e.data));
// The stream died, not the account. Swap the icon too: leaving the previous
// state's tick beside a failure is how a killed server reads as a finished sync.
// Clear the quiet timer as well, since seconds-since-last-batch stops meaning
// anything the moment we stopped being told about batches.
es.onerror=()=>{
  $("#label").textContent="Lost the connection to this page";
  $("#markUse").setAttribute("href","#i-stop");
  $(".mark").classList.add("stop"); $(".mark").classList.remove("pulse");
  $("#detail").textContent="The sync itself is unaffected — this page stopped being told about it. Run the command again to watch.";
  clearInterval(quietTick); $("#quiet").textContent="";
};
`;

/** The direction contract. Emitted into the served markup, first child of body. */
const CONTRACT = `<!--
THESIS: a first sync is a print developing — it cannot be rushed, so show the image
arriving. Refuses the category default: a white card, a QR, and a spinner.
OWN-WORLD: darkroom under safelight. Near-black ground, one amber light source, oxblood
rebate, true paper for the print. Tabular timer digits. Lights-on variant for light mode.
STORY: the code is a negative on the lightbox; scanning puts it in the tray; the counts
come up as the history arrives, and the page reports when they stop rather than
claiming a completeness the protocol never signals.
FIRST VIEWPORT: the print centred, QR on paper inside a photographic rebate, a depleting
ring around it carrying the code's own 20s life; status beneath it; three counters below,
undeveloped until they hold data.
FORM: candidate 6 of 7 grounded directions (darkroom safelight).
NOTE: system type stack, not a sourced display face — the page makes no external
request of any kind, so a webfont is not available to it and should not be.
-->`;

export function page(initial: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link WhatsApp</title><style>${CSS}</style></head>
<body data-view="wait">${CONTRACT}
<svg width="0" height="0" aria-hidden="true" style="position:absolute">
 <defs>
  <g id="i-scan" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
   <path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M17 3h2.5A1.5 1.5 0 0 1 21 4.5V7M21 17v2.5a1.5 1.5 0 0 1-1.5 1.5H17M7 21H4.5A1.5 1.5 0 0 1 3 19.5V17"/></g>
  <g id="i-wait" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
   <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></g>
  <g id="i-done" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
   <circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.4l2.4 2.4 4.6-5"/></g>
  <g id="i-stop" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
   <circle cx="12" cy="12" r="8.5"/><path d="M12 7.6v5.2M12 16.2v.2"/></g>
 </defs></svg>

<main class="wrap">
 <div>
  <h1 id="title">Link WhatsApp</h1>
  <p class="path guide"><b>WhatsApp</b><span>›</span>Settings<span>›</span>Linked devices<span>›</span><b>Link a device</b></p>
 </div>

 <div class="stage">
 <div class="print">
  <div class="sheet developing">
   <svg class="qr" viewBox="-2 -2 29 29" shape-rendering="crispEdges" role="img"
        aria-label="Pairing QR code"><path d=""/></svg>
  </div>
 </div>
 <div class="life" aria-hidden="true"><i id="life"></i></div>
 </div>

 <div style="display:grid;gap:.5rem;justify-items:center">
  <p class="status" role="status" aria-live="polite">
   <svg class="mark pulse" viewBox="0 0 24 24" aria-hidden="true"><use id="markUse" href="#i-wait"/></svg>
   <span id="label">Starting up</span></p>
  <p class="detail" id="detail"></p>
  <p class="detail" id="quiet" role="status" aria-live="polite"></p>
 </div>

 <dl class="counts">
  <div><dt>Chats</dt><dd id="chats">0</dd></div>
  <div><dt>Messages</dt><dd id="msgs">0</dd></div>
  <div><dt>Reached back to</dt><dd class="sm" id="oldest">—</dd></div>
 </dl>

 <p class="kinds" aria-label="History kinds received">
  <b id="k-initial_bootstrap">bootstrap <i>0</i></b><b id="k-recent">recent <i>0</i></b>
  <b id="k-full">full <i>0</i></b><b id="k-on_demand">on demand <i>0</i></b>
 </p>

 <p class="fallback">Can’t scan from here? The same code is in <code>qr.txt</code>.</p>
</main>
<script>${JS}
render(${initial});</script></body></html>`;
}
