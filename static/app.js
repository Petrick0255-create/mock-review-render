let job=null, currentNumber=null;
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const colors=['#dbeafe','#a7d8f0','#76b7df','#ffd27a','#f39a63','#d95d5d'];
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600)}
function busy(on,text='처리 중…'){$('#busyText').textContent=text;$('#busy').classList.toggle('hidden',!on)}
function switchView(id){$$('.view').forEach(v=>v.classList.toggle('active',v.id===id));$$('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===id));if(id==='roadmapView')renderRoadmap()}
$$('.bottom-nav button').forEach(b=>b.onclick=()=>switchView(b.dataset.view));
$$('input[type=file]').forEach(input=>input.onchange=()=>input.closest('.dropzone').querySelector('.filename').textContent=input.files[0]?.name||'선택되지 않음');
$$('.dropzone').forEach(zone=>{
  const input=zone.querySelector('input[type=file]');
  ['dragenter','dragover'].forEach(eventName=>zone.addEventListener(eventName,event=>{event.preventDefault();event.stopPropagation();zone.classList.add('dragging')}));
  ['dragleave','drop'].forEach(eventName=>zone.addEventListener(eventName,event=>{event.preventDefault();event.stopPropagation();zone.classList.remove('dragging')}));
  zone.addEventListener('drop',event=>{
    const file=event.dataTransfer.files?.[0];
    if(!file)return;
    if(!/\.(hwp|hwpx|pdf)$/i.test(file.name)){toast('HWP, HWPX, PDF 파일만 올릴 수 있습니다.');return}
    const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change'));
  });
});
$('#settingsBtn').onclick=()=>{$('#apiKey').value=localStorage.getItem('mockReviewGeminiKey')||'';$('#rememberKey').checked=!!$('#apiKey').value;$('#settingsDialog').showModal()};
$('#saveSettings').onclick=()=>{if($('#rememberKey').checked)localStorage.setItem('mockReviewGeminiKey',$('#apiKey').value);else localStorage.removeItem('mockReviewGeminiKey');toast('설정을 저장했습니다.')};
$('#uploadForm').onsubmit=async e=>{e.preventDefault();busy(true,'문항을 찾고 미리보기를 만드는 중…');try{const res=await fetch('/api/upload',{method:'POST',body:new FormData(e.target)});const data=await res.json();if(!res.ok)throw new Error(data.detail||'업로드 실패');job=data;currentNumber=job.items[0]?.number;renderReview();switchView('reviewView');toast(`${job.items.length}개 문항을 찾았습니다.`)}catch(err){toast(err.message)}finally{busy(false)}};
function renderReview(){
  $('#warnings').innerHTML=(job.warnings||[]).map(w=>`<div class="warning">⚠ ${escapeHtml(w)}</div>`).join('');
  $('#questionStrip').innerHTML=job.items.map(item=>`<button data-number="${item.number}" class="${item.number===currentNumber?'active ':''}${item.analysis?'done ':''}${item.analysis_error?'error':''}">${String(item.number).padStart(2,'0')}</button>`).join('');
  $$('#questionStrip button').forEach(b=>b.onclick=()=>{currentNumber=+b.dataset.number;renderReview()});
  const item=job.items.find(x=>x.number===currentNumber);if(!item){$('#questionDetail').innerHTML='문항이 없습니다.';return}
  const pane=(title,url)=>`<div class="document-pane"><h3>${title}</h3>${url?`<img src="${url}" alt="${title} 미리보기">`:'<div class="missing">파일 또는 해당 번호 없음</div>'}</div>`;
  let result='<div class="result-card"><p>아직 분석하지 않았습니다. 문항별 분석 또는 전체 AI 분석을 실행하세요.</p></div>';
  if(item.analysis){const a=item.analysis;result=`<div class="result-card"><div class="result-summary"><div><small>난이도</small><b>${escapeHtml(a.difficulty_label)} · ${a.difficulty_score}/6</b></div><div><small>추천 배점</small><b>${a.recommended_points}점</b></div><div><small>추정 정답</small><b>${escapeHtml(a.answer||'-')}</b></div><div><small>확신도</small><b>${a.confidence}%</b></div></div><p>${escapeHtml(a.summary||'')}</p><div class="error-list">${(a.errors||[]).length?(a.errors||[]).map(er=>`<div class="error-item" data-severity="${escapeHtml(er.severity)}"><b>${escapeHtml(er.severity)} · ${escapeHtml(er.category)} · ${escapeHtml(er.location)}</b>${escapeHtml(er.message)}<br><small>수정안: ${escapeHtml(er.suggestion)}</small></div>`).join(''):'<div class="insight">발견된 오류가 없습니다.</div>'}</div></div>`}
  if(item.analysis_error)result=`<div class="result-card"><div class="error-item" data-severity="치명"><b>분석 실패</b>${escapeHtml(item.analysis_error)}</div></div>`;
  $('#questionDetail').classList.remove('empty');$('#questionDetail').innerHTML=`<div class="detail-head"><h2>${String(item.number).padStart(2,'0')}번</h2><button class="primary compact" id="analyzeOne">이 문항 분석</button></div><div class="document-grid">${pane('문제지',item.problem_preview)}${pane('해설',item.solution_preview)}</div>${result}`;
  $('#analyzeOne').onclick=()=>runAnalysis(item.number);
}
async function runAnalysis(number=null){if(!job)return;busy(true,number?`${String(number).padStart(2,'0')}번 분석 중…`:'전체 문항을 차례로 분석 중…');try{const apiKey=$('#apiKey').value||localStorage.getItem('mockReviewGeminiKey')||'';const res=await fetch(`/api/jobs/${job.id}/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:apiKey,number})});const data=await res.json();if(!res.ok)throw new Error(data.detail||'분석 실패');job=data;renderReview();renderRoadmap();toast(number?'문항 분석을 마쳤습니다.':'전체 분석을 마쳤습니다.')}catch(err){toast(err.message)}finally{busy(false)}}
$('#analyzeAll').onclick=()=>runAnalysis();
function analyzed(){return job?job.items.filter(x=>x.analysis):[]}
function renderRoadmap(){
  const items=analyzed(), total=items.length, avg=total?(items.reduce((s,x)=>s+x.analysis.difficulty_score,0)/total).toFixed(1):'-', points=total?items.reduce((s,x)=>s+x.analysis.recommended_points,0):0, errors=items.reduce((s,x)=>s+(x.analysis.errors||[]).length,0);
  $('#metricGrid').innerHTML=[['분석 문항',`${total}${job?` / ${job.items.length}`:''}`],['평균 난이도',avg],['추천 총점',`${points}점`],['발견 오류',`${errors}건`]].map(x=>`<div class="metric"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join('');
  if(!total){$('#roadmap').className='roadmap empty';$('#roadmap').textContent='분석 결과가 쌓이면 표시됩니다.';$('#distribution').innerHTML='';$('#insights').innerHTML='<div class="insight">전체 AI 분석을 실행하세요.</div>';return}
  $('#roadmap').className='roadmap';const width=Math.max(700,items.length*56+70),height=290,left=48,top=20,bottom=38,plot=height-top-bottom,x=i=>left+(width-left-25)*(i/Math.max(1,items.length-1)),y=s=>top+(6-s)*(plot/5);
  let svg=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="문항별 난이도 그래프">`;
  for(let s=1;s<=6;s++)svg+=`<line x1="${left}" y1="${y(s)}" x2="${width-20}" y2="${y(s)}" stroke="#e7ebf1"/><text x="10" y="${y(s)+4}" font-size="10" fill="#7d8798">${['','하','중하','중','중상','상','최상'][s]}</text>`;
  svg+=`<polyline fill="none" stroke="#3168d5" stroke-width="2.5" points="${items.map((it,i)=>`${x(i)},${y(it.analysis.difficulty_score)}`).join(' ')}"/>`;
  items.forEach((it,i)=>{const s=it.analysis.difficulty_score;svg+=`<g class="point" data-number="${it.number}"><circle cx="${x(i)}" cy="${y(s)}" r="8" fill="${colors[s-1]}" stroke="#17233d" stroke-width="1.5"/><text x="${x(i)}" y="${height-13}" text-anchor="middle" font-size="10" fill="#667085">${String(it.number).padStart(2,'0')}</text>${(it.analysis.errors||[]).length?`<text x="${x(i)}" y="${y(s)-13}" text-anchor="middle" font-size="10" fill="#d95d5d">!${it.analysis.errors.length}</text>`:''}<title>${it.number}번 · ${it.analysis.difficulty_label} · ${it.analysis.recommended_points}점</title></g>`});svg+='</svg>';$('#roadmap').innerHTML=svg;$$('#roadmap .point').forEach(p=>p.onclick=()=>{currentNumber=+p.dataset.number;renderReview();switchView('reviewView')});
  const counts=[1,2,3,4,5,6].map(s=>items.filter(x=>x.analysis.difficulty_score===s).length);$('#distribution').innerHTML=counts.map((c,i)=>`<div class="dist-row"><span>${['하','중하','중','중상','상','최상'][i]}</span><div class="bar"><i style="width:${c/total*100}%;background:${colors[i]}"></i></div><b>${c}</b></div>`).join('');
  const insights=[];let streak=[];items.forEach(it=>{if(it.analysis.difficulty_score>=5)streak.push(it.number);else{if(streak.length>=3)insights.push(`${streak[0]}~${streak.at(-1)}번에 고난도 문항이 연속됩니다.`);streak=[]}});if(streak.length>=3)insights.push(`${streak[0]}~${streak.at(-1)}번에 고난도 문항이 연속됩니다.`);if(counts[0]+counts[1]>total*.55)insights.push('쉬운 문항 비율이 절반을 넘습니다.');if(counts[4]+counts[5]>total*.4)insights.push('상·최상 문항 비율이 높습니다.');if(errors)insights.push(`${errors}개의 검토 항목을 문항 카드에서 확인하세요.`);if(!insights.length)insights.push('난이도 분포에서 뚜렷한 편중을 찾지 못했습니다.');$('#insights').innerHTML=insights.map(x=>`<div class="insight">${escapeHtml(x)}</div>`).join('');
}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
renderRoadmap();
