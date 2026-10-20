(() => {
'use strict';
const K = {meds:'pp.meds', doses:'pp.doses', set:'pp.settings'};
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = () => { localStorage.setItem(K.meds, JSON.stringify(meds)); localStorage.setItem(K.doses, JSON.stringify(doses)); localStorage.setItem(K.set, JSON.stringify(S)); };
let meds = load(K.meds, []);
let doses = load(K.doses, {}); // key -> {medId,date,time,status:'due'|'taken',dueAt,lastFired,count,takenAt}
const S = Object.assign({voice:true, mute:false, clean:false, interval:10, speed:1, voiceName:''}, load(K.set, {}));
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fmtTime = hm => { const [h,m] = hm.split(':').map(Number); return `${(h%12)||12}:${pad(m)} ${h<12?'AM':'PM'}`; };
const atTime = (dk, hm) => { const [y,mo,d] = dk.split('-').map(Number); const [h,m] = hm.split(':').map(Number); return new Date(y,mo-1,d,h,m,0,0).getTime(); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const medById = id => meds.find(m => m.id === id);

// Speech-friendly dosage ("10 mg" -> "10 milligrams"); display always uses exactly what was typed.
const UNITS = {mg:'milligrams', mcg:'micrograms', 'µg':'micrograms', ug:'micrograms', g:'grams', ml:'milliliters', mL:'milliliters', iu:'international units', IU:'international units', u:'units'};
const spokenDose = d => d.replace(/(\d)\s*(mcg|µg|ug|mg|mL|ml|IU|iu|g|u)\b/g, (_, n, u) => `${n} ${UNITS[u] || u}`);
const tierOf = c => Math.min(5, 1 + Math.floor((c - 1) * Number(S.speed)));
function lineFor(d, tier, spoken) {
  const m = medById(d.medId); if (!m) return '';
  const pool = (!S.clean && tier >= 4) ? FOUL[tier] : LINES[tier];
  const raw = pool[Math.floor(Math.random() * pool.length)];
  const mins = Math.max(0, Math.round((Date.now() - d.dueAt) / 60000));
  const M = spoken ? `${m.name}, ${spokenDose(m.dose)}` : `${m.name} ${m.dose}`;
  return raw.split('{M}').join(M).split('{T}').join(fmtTime(d.time)).split('{N}').join(String(mins));
}

// ---------- speech ----------
let unlocked = false;
const canSpeak = 'speechSynthesis' in window;
function speak(text, tier) {
  if (!canSpeak || !S.voice || S.mute || !unlocked) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = [1, 0.95, 1.05, 1.15, 1.25, 1.35][tier];
  u.pitch = [1, 1, 1.05, 1.15, 1.3, 1.5][tier];
  u.volume = 1;
  const v = speechSynthesis.getVoices().find(v => v.name === S.voiceName); if (v) u.voice = v;
  speechSynthesis.speak(u); // queued; never cancels another dose's reminder
}
function fillVoices() {
  if (!canSpeak) return; const sel = $('#sVoiceName');
  const vs = speechSynthesis.getVoices(); if (!vs.length) return;
  sel.innerHTML = '<option value="">Default</option>' + vs.map(v => `<option ${v.name===S.voiceName?'selected':''} value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
}
if (canSpeak) { speechSynthesis.onvoiceschanged = fillVoices; }

// ---------- notifications ----------
async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {body, tag, renotify:true, requireInteraction:true, icon:'./icons/icon-192.png', badge:'./icons/icon-192.png', silent: S.mute};
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { try { new Notification(title, opts); } catch {} }
}

// ---------- scheduler ----------
function fire(key) {
  const d = doses[key]; const m = medById(d.medId); if (!m) return;
  d.count += 1; d.lastFired = Date.now();
  const tier = tierOf(d.count);
  d.lastLine = lineFor(d, tier, false);
  save();
  speak(lineFor(d, tier, true), tier);
  notify(`💊 ${m.name} ${m.dose} — ${fmtTime(d.time)}`, d.lastLine, key);
  if (document.hidden) document.title = `⚠️ ${m.name} due!`;
}
function tick() {
  const now = Date.now(), today = dateKey(new Date());
  for (const m of meds) for (const t of m.times) {
    const key = `${today}|${m.id}|${t}`; const due = atTime(today, t);
    if (now >= due && !doses[key] && due >= (m.createdAt || 0) - 60000) {
      doses[key] = {medId:m.id, date:today, time:t, status:'due', dueAt:due, lastFired:0, count:0};
      fire(key);
    }
  }
  const iv = Math.max(1, Number(S.interval) || 10) * 60000;
  for (const [key, d] of Object.entries(doses)) {
    if (d.status !== 'due') continue;
    if (!medById(d.medId)) { delete doses[key]; continue; }
    if (now - d.lastFired >= iv) fire(key);   // no cap, no auto-stop — only "I took it" ends this
  }
  // prune old taken records (>3 days)
  for (const [key, d] of Object.entries(doses)) if (d.status === 'taken' && now - d.dueAt > 3*864e5) delete doses[key];
  save(); render();
}
function markTaken(key) {
  const d = doses[key]; if (!d) return;
  d.status = 'taken'; d.takenAt = Date.now(); save();
  if (canSpeak && unlocked && !S.mute && S.voice && !Object.values(doses).some(x => x.status === 'due')) speechSynthesis.cancel();
  toast(d.count >= 4 ? (S.clean ? 'FINALLY. Thank you. 😮‍💨' : 'about damn time. love you 😮‍💨') : 'Nice! Logged ✅');
  document.title = 'PillPal Unhinged'; render();
}
function takeEarly(medId, time) {
  const today = dateKey(new Date()); const key = `${today}|${medId}|${time}`;
  doses[key] = {medId, date:today, time, status:'taken', dueAt:atTime(today,time), lastFired:Date.now(), count:0, takenAt:Date.now()};
  save(); toast('Taken early — logged ✅'); render();
}

// ---------- render ----------
function render() {
  const now = new Date(); const today = dateKey(now);
  $('#clock').textContent = now.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  $('#todayDate').textContent = now.toLocaleDateString([], {weekday:'long', month:'short', day:'numeric'});
  const pending = Object.entries(doses).filter(([,d]) => d.status === 'due' && medById(d.medId)).sort((a,b) => a[1].dueAt - b[1].dueAt);
  const maxTier = pending.reduce((t,[,d]) => Math.max(t, tierOf(Math.max(1,d.count))), 1);
  document.body.dataset.tier = pending.length ? maxTier : 1;
  document.querySelector('meta[name=theme-color]').content = getComputedStyle(document.body).getPropertyValue('--a').trim() || '#3b82f6';
  $('#banners').innerHTML = pending.map(([key, d]) => {
    const m = medById(d.medId); const tier = tierOf(Math.max(1,d.count));
    const mins = Math.round((Date.now() - d.dueAt)/60000);
    const next = Math.max(0, Math.ceil(((d.lastFired + S.interval*60000) - Date.now())/60000));
    return `<div class="banner" data-t="${tier}"><div class="facts">💊 ${esc(m.name)} — ${esc(m.dose)}</div>
      <div class="meta">Scheduled ${fmtTime(d.time)}${d.date!==today?' ('+esc(d.date)+')':''} · ${mins} min overdue · reminder #${d.count} · tier ${tier}/5 · next in ${next} min</div>
      <div class="say">“${esc(d.lastLine || '')}”</div>
      <button class="btn" data-take="${esc(key)}">✅ I took it</button></div>`;
  }).join('');
  const rows = [];
  for (const m of meds) for (const t of m.times) {
    const key = `${today}|${m.id}|${t}`; const d = doses[key]; const due = atTime(today,t);
    let st = d ? d.status : (now.getTime() >= due ? 'missed' : 'upcoming');
    rows.push({m, t, key, st, d});
  }
  rows.sort((a,b) => a.t.localeCompare(b.t));
  $('#today').innerHTML = rows.length ? rows.map(({m,t,key,st,d}) => {
    const label = st==='due' ? (Date.now()-d.dueAt > 60000 ? 'Overdue' : 'Due') : st==='taken' ? 'Taken' : st==='missed' ? 'Before added' : 'Upcoming';
    const btn = st==='due' ? `<button class="btn primary sm" data-take="${esc(key)}">Mark as taken</button>`
      : st==='upcoming' ? `<button class="btn ghost sm" data-early="${esc(m.id)}|${esc(t)}">Take now</button>`
      : st==='taken' ? `<span class="muted">${new Date(d.takenAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span>` : '';
    return `<div class="dose st-${st==='due'?'due':st}"><div class="t">${fmtTime(t)}</div><div class="info"><div class="nm">${esc(m.name)}</div><div class="ds">${esc(m.dose)} · <span class="pill">${label}</span></div></div>${btn}</div>`;
  }).join('') : '<div class="empty">No meds yet. Tap “+ Add” to get started.</div>';
  $('#medList').innerHTML = meds.length ? meds.map(m => `<div class="med"><div><div class="nm"><b>${esc(m.name)}</b> · ${esc(m.dose)}</div><div class="times">${m.times.map(fmtTime).join(' · ')}</div></div>
    <div class="acts"><button class="btn ghost sm" data-edit="${esc(m.id)}">Edit</button><button class="btn danger sm" data-del="${esc(m.id)}">Delete</button></div></div>`).join('') : '<div class="empty">Nothing here yet.</div>';
}

// ---------- med form ----------
let editing = null;
function timeRow(v='') { const r = document.createElement('div'); r.className='trow'; r.innerHTML = `<input type="time" required value="${esc(v)}"><button type="button" class="btn ghost sm" aria-label="Remove time">✕</button>`; r.querySelector('button').onclick = () => { if ($('#fTimes').children.length > 1) r.remove(); }; $('#fTimes').append(r); }
function openMed(m) {
  editing = m ? m.id : null; $('#medDlgTitle').textContent = m ? 'Edit medication' : 'Add medication';
  $('#fName').value = m ? m.name : ''; $('#fDose').value = m ? m.dose : ''; $('#fTimes').innerHTML = '';
  (m ? m.times : ['08:00']).forEach(timeRow); $('#medDlg').showModal();
}
$('#addBtn').onclick = () => openMed(null);
$('#addTime').onclick = () => timeRow('');
$('#cancelMed').onclick = () => $('#medDlg').close();
$('#medForm').onsubmit = e => {
  const name = $('#fName').value.trim(), dose = $('#fDose').value.trim();
  const times = [...new Set([...$('#fTimes').querySelectorAll('input')].map(i => i.value).filter(v => /^\d{2}:\d{2}$/.test(v)))].sort();
  if (!name || !dose || !times.length) { e.preventDefault(); toast('Need a name, dosage and at least one time'); return; }
  if (editing) {
    const m = medById(editing); m.name = name; m.dose = dose; m.times = times;
    for (const [k,d] of Object.entries(doses)) if (d.medId === m.id && d.status === 'due' && !times.includes(d.time)) delete doses[k];
  } else meds.push({id:uid(), name, dose, times, createdAt:Date.now()});
  save(); tick(); toast('Saved 💾');
};
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.take) markTaken(b.dataset.take);
  else if (b.dataset.early) { const [id,t] = b.dataset.early.split('|'); takeEarly(id,t); }
  else if (b.dataset.edit) openMed(medById(b.dataset.edit));
  else if (b.dataset.del) { const m = medById(b.dataset.del); if (m && confirm(`Delete ${m.name} ${m.dose}? Its pending reminders will stop.`)) { meds = meds.filter(x => x.id !== m.id); for (const [k,d] of Object.entries(doses)) if (d.medId === m.id) delete doses[k]; save(); render(); } }
});

// ---------- settings ----------
$('#settingsBtn').onclick = () => { $('#sVoice').checked=S.voice; $('#sMute').checked=S.mute; $('#sClean').checked=S.clean; $('#sInterval').value=S.interval; $('#sSpeed').value=String(S.speed); fillVoices(); $('#setDlg').showModal(); };
$('#setDlg').addEventListener('change', () => {
  S.voice=$('#sVoice').checked; S.mute=$('#sMute').checked; S.clean=$('#sClean').checked;
  S.interval=Math.min(120, Math.max(1, parseInt($('#sInterval').value,10) || 10)); S.speed=Number($('#sSpeed').value); S.voiceName=$('#sVoiceName').value;
  if (S.mute && canSpeak) speechSynthesis.cancel(); save(); render();
});
$('#testVoice').onclick = () => { unlock(); const fake = {medId:'__t', time:'08:00', dueAt:Date.now()-40*60000}; const keep = meds; meds = keep.concat([{id:'__t', name:'Lisinopril', dose:'10 mg', times:['08:00']}]);
  for (let t=1;t<=5;t++) speak(lineFor(fake,t,true), t); meds = keep; };

// ---------- unlock ----------
function unlock() {
  if (canSpeak && !unlocked) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
  unlocked = true; localStorage.setItem('pp.unlocked','1'); $('#unlock').hidden = true;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(()=>{});
  // re-speak most urgent pending reminder now that audio is allowed
  const p = Object.values(doses).filter(d => d.status==='due' && medById(d.medId)); if (p.length) { const d=p[0]; speak(lineFor(d, tierOf(d.count), true), tierOf(d.count)); }
}
$('#unlockBtn').onclick = unlock;
// Any later tap also (re)unlocks audio after a reload; the card is shown again every load since browsers require a fresh gesture.
document.addEventListener('pointerdown', () => { if (!unlocked && localStorage.getItem('pp.unlocked')) unlock(); }, {once:true});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title='PillPal Unhinged'; tick(); } });

let tt; function toast(t) { const el=$('#toast'); el.textContent=t; el.classList.add('on'); clearTimeout(tt); tt=setTimeout(()=>el.classList.remove('on'),2200); }
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
tick(); setInterval(tick, 5000);
})();
