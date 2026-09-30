const state={data:{people:[],relationships:[]},selected:null,search:'',token:localStorage.getItem('familyToken')||'',history:null,adminSecret:'',homeRootId:null,modalOpen:false,ancestorLevels:3,descendantLevels:4};
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const full=p=>[p?.given_name,p?.surname].filter(Boolean).join(' ')||'Unnamed';
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const api=async(path,opts={})=>{const r=await fetch(path,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||`Request failed (${r.status})`);return j};
function notice(msg){$('#notice').innerHTML=msg?`<div class="notice">${esc(msg)}</div>`:''}
function saveToken(v){state.token=v.replace(/\D/g,'').slice(0,5);localStorage.setItem('familyToken',state.token);$('#token').value=state.token}
async function loadTree(){try{state.data=await api('/api/tree');ensureHomeRoot();renderTree()}catch(e){try{state.data=await (await fetch('/demo.json')).json();ensureHomeRoot();notice('Demo mode: the tree is loaded from the prepared family data. Connect Neon to enable live proposals and moderation.');renderTree()}catch(x){notice(x.message)}}}
function tab(id){document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));if(id==='tree')renderTree();if(id==='history')renderHistory();if(id==='contribute')renderContribute();if(id==='admin')renderAdmin()}
$('#nav').addEventListener('click',e=>{if(e.target.dataset.tab)tab(e.target.dataset.tab)});
$('#token').value=state.token;$('#token').addEventListener('input',e=>saveToken(e.target.value));

function buildIndexes(){
  const people=new Map((state.data.people||[]).map(p=>[p.id,p]));
  const parents=new Map(),children=new Map(),spouses=new Map();
  for(const r of state.data.relationships||[]){
    if(r.relationship_type==='parent'){
      if(!parents.has(r.to_person_id))parents.set(r.to_person_id,[]);
      if(!children.has(r.from_person_id))children.set(r.from_person_id,[]);
      parents.get(r.to_person_id).push(r.from_person_id);
      children.get(r.from_person_id).push(r.to_person_id);
    }else if(r.relationship_type==='spouse'){
      if(!spouses.has(r.from_person_id))spouses.set(r.from_person_id,[]);
      if(!spouses.has(r.to_person_id))spouses.set(r.to_person_id,[]);
      spouses.get(r.from_person_id).push(r.to_person_id);
      spouses.get(r.to_person_id).push(r.from_person_id);
    }
  }
  for(const map of [parents,children,spouses])for(const [id,ids] of map)map.set(id,[...new Set(ids)]);
  return {people,parents,children,spouses};
}
function ensureHomeRoot(){
  const index=buildIndexes();
  const preferred=[...index.people.values()].find(p=>norm(full(p))==='kyeboadu');
  if(preferred){state.homeRootId=preferred.id;return preferred}
  const roots=[...index.people.values()].filter(p=>!(index.parents.get(p.id)||[]).length);
  const score=p=>{let n=0,q=[p.id],seen=new Set(q);while(q.length){const id=q.shift();for(const c of index.children.get(id)||[]){if(!seen.has(c)){seen.add(c);q.push(c);n++}}}return n};
  const root=roots.sort((a,b)=>score(b)-score(a))[0]||[...index.people.values()][0];
  state.homeRootId=root?.id||null;return root;
}
function personCard(p,{selected=false,compact=false,modal=true}={}){
  if(!p)return '';
  const years=p.birth_year||p.death_year?`${p.birth_year||'?'}${p.death_year?` — ${p.death_year}`:''}`:'Dates unknown';
  const source=p.source==='excel'?'Excel import':'Family record';
  const dot=p.sex==='M'?'male':p.sex==='F'?'female':'unknown';
  return `<button class="gene-person ${selected?'is-selected':''} ${compact?'compact':''}" data-node="${esc(p.id)}" data-open-tree="${modal?'1':'0'}" type="button">
    <span class="person-avatar ${dot}">${esc((p.given_name||'?').charAt(0).toUpperCase())}</span>
    <span class="person-copy"><strong>${esc(full(p))}</strong><small>${esc(years)}</small><em>${esc(source)}</em></span>
  </button>`;
}
function generationLabel(distance,direction){
  if(direction==='ancestor'){
    if(distance===1)return 'Parents'; if(distance===2)return 'Grandparents'; if(distance===3)return 'Great-grandparents';
    return `${'Great-'.repeat(Math.max(0,distance-2))}grandparents`;
  }
  if(distance===1)return 'Children'; if(distance===2)return 'Grandchildren'; if(distance===3)return 'Great-grandchildren';
  return `${'Great-'.repeat(Math.max(0,distance-2))}grandchildren`;
}
function ancestorGenerations(root,index,maxLevels=3){
  const generations=[];let frontier=[root];const seen=new Set([root.id]);let distance=0;
  while(frontier.length&&distance<maxLevels){
    const next=[];
    for(const person of frontier)for(const id of index.parents.get(person.id)||[]){if(seen.has(id))continue;seen.add(id);const p=index.people.get(id);if(p)next.push(p)}
    if(!next.length)break;distance++;const unique=[...new Map(next.map(p=>[p.id,p])).values()];generations.push({distance,people:unique});frontier=unique;
  }
  return generations.reverse();
}
function descendantGenerations(root,index,maxLevels=4){
  const generations=[];let frontier=[root];const seen=new Set([root.id]);let distance=0;
  while(frontier.length&&distance<maxLevels){
    const next=[];
    for(const person of frontier)for(const id of index.children.get(person.id)||[]){if(seen.has(id))continue;seen.add(id);const p=index.people.get(id);if(p)next.push(p)}
    if(!next.length)break;distance++;const unique=[...new Map(next.map(p=>[p.id,p])).values()];generations.push({distance,people:unique});frontier=unique;
  }
  return generations;
}
function siblings(root,index){
  const ids=new Set();
  for(const parentId of index.parents.get(root.id)||[])for(const childId of index.children.get(parentId)||[])if(childId!==root.id)ids.add(childId);
  return [...ids].map(id=>index.people.get(id)).filter(Boolean).sort((a,b)=>full(a).localeCompare(full(b)));
}
function renderGeneration(g,index,direction){
  const people=[...g.people].sort((a,b)=>full(a).localeCompare(full(b)));
  return `<section class="generation"><div class="generation-heading"><span>${esc(generationLabel(g.distance,direction))}</span><small>${people.length} ${people.length===1?'person':'people'}</small></div><div class="generation-people">${people.map(p=>{
    const ss=(index.spouses.get(p.id)||[]).map(id=>index.people.get(id)).filter(Boolean);
    return `<div class="family-unit"><div class="person-pair">${personCard(p)}${ss.length?`<div class="unit-spouses">${ss.map(s=>`<span class="union">&amp;</span>${personCard(s,{compact:true})}`).join('')}</div>`:''}</div></div>`;
  }).join('')}</div></section>`;
}
function findSearchMatches(){
  if(!state.search)return [];
  const q=norm(state.search);const people=state.data.people||[];
  return people.filter(p=>norm(full(p)).includes(q)||(p.aliases||[]).some(a=>norm(a).includes(q))).slice(0,20);
}
function renderSearchResults(){
  const box=$('#searchResults');if(!box)return;
  const matches=findSearchMatches();
  box.innerHTML=matches.length?matches.map(p=>`<button data-person="${esc(p.id)}" type="button"><span>${esc(full(p))}</span><small>${esc(p.birth_year||'')}</small></button>`).join(''):(state.search?'<p class="muted">No matching family member.</p>':'');
  box.querySelectorAll('[data-person]').forEach(b=>b.onclick=()=>{state.search='';renderSearchResults();openTreeModal(b.dataset.person)});
}
function homeRoot(){const index=buildIndexes();return index.people.get(state.homeRootId)||ensureHomeRoot()}
function renderTree(){
  const people=state.data.people||[];ensureHomeRoot();
  if(!state.selected)state.selected=state.homeRootId||people[0]?.id;
  const selected=people.find(p=>p.id===state.selected)||homeRoot()||people[0];if(!selected)return;state.selected=selected.id;
  const index=buildIndexes();const ancestors=ancestorGenerations(selected,index,2);const descendants=descendantGenerations(selected,index,3);const sibs=siblings(selected,index);const spouses=(index.spouses.get(selected.id)||[]).map(id=>index.people.get(id)).filter(Boolean);const root=homeRoot();
  $('#main').innerHTML=`<main class="tree-page">
    <aside class="tree-sidebar">
      <div class="sidebar-title"><span class="eyebrow">FAMILY TREE</span><h2>Find a person</h2></div>
      <input id="search" value="${esc(state.search)}" placeholder="Search by name…" autocomplete="off">
      <div id="searchResults" class="results"></div>
      <button id="homeTree" class="home-button" type="button">⌂ View family from the roots</button>
      <div class="tree-help"><strong>How to read the tree</strong><p>Choose a person to open a full family view. In that view you can choose how many generations of ancestors and descendants to display.</p><p>The tree opens in a scrollable window so large families can be explored without shrinking the cards.</p></div>
      <div class="legend"><div><i class="legend-dot male"></i> Male</div><div><i class="legend-dot female"></i> Female</div><div><i class="legend-dot unknown"></i> Not recorded</div></div>
    </aside>
    <section class="tree-area">
      <div class="tree-toolbar"><div><strong>${esc(full(selected))}</strong><span>${selected.id===root?.id?'Family roots':'Family member preview'}</span></div><div class="toolbar-actions"><button id="openSelected" type="button">Open full tree</button><button id="homeTreeTop" type="button">⌂ Roots</button></div></div>
      <div class="lineage-scroll"><div class="lineage">
        <section class="focus-section home-preview"><div class="section-title"><span>${selected.id===root?.id?'FAMILY ROOT':'SELECTED FAMILY MEMBER'}</span><small>${selected.id===root?.id?'Beginning of the recorded clan line':'Preview — open the full tree for more generations'}</small></div>
          <div class="focus-family"><div class="focus-person">${personCard(selected,{selected:true})}</div>${spouses.length?`<div class="focus-spouses">${spouses.map(s=>`<span class="union">&amp;</span>${personCard(s,{compact:true})}`).join('')}</div>`:''}</div>
          ${selected.notes?`<div class="focus-note">${esc(selected.notes)}</div>`:''}
        </section>
        ${selected.id===root?.id&&descendants.length?`<div class="lineage-section descendants preview-desc"><div class="section-title"><span>ROOT LINE</span><small>First ${descendants.length} recorded generations</small></div>${descendants.map(g=>renderGeneration(g,index,'descendant')).join('<div class="generation-arrow">↓</div>')}</div>`:''}
        ${selected.id!==root?.id?`<section class="open-prompt"><h3>Explore ${esc(full(selected))}'s family</h3><p>Open the full tree to choose the number of ancestor and descendant generations.</p><button id="openSelected2" class="primary" type="button">Open family tree</button></section>`:''}
      </div></div>
    </section>
  </main>`;
  $('#search').addEventListener('input',e=>{state.search=e.target.value;renderSearchResults()});
  renderSearchResults();
  $('#homeTree').onclick=()=>{state.selected=state.homeRootId;state.search='';renderTree()};
  $('#homeTreeTop').onclick=()=>{state.selected=state.homeRootId;state.search='';renderTree()};
  $('#openSelected').onclick=()=>openTreeModal(selected.id);
  $('#openSelected2')?.addEventListener('click',()=>openTreeModal(selected.id));
  document.querySelectorAll('[data-node]').forEach(b=>b.addEventListener('click',()=>openTreeModal(b.dataset.node)));
}
function renderModalTree(personId){
  const index=buildIndexes();const selected=index.people.get(personId)||homeRoot();if(!selected)return '';
  state.selected=selected.id;
  const ancestors=ancestorGenerations(selected,index,state.ancestorLevels);const descendants=descendantGenerations(selected,index,state.descendantLevels);const sibs=siblings(selected,index);const spouses=(index.spouses.get(selected.id)||[]).map(id=>index.people.get(id)).filter(Boolean);
  return `<div class="modal-tree-shell">
    <div class="modal-toolbar"><div><span class="eyebrow">FAMILY LINEAGE</span><h2>${esc(full(selected))}</h2><p>Use the controls to choose how far up and down the family tree you want to see.</p></div><button id="closeTreeModal" class="modal-close" type="button">×</button></div>
    <div class="tree-controls"><label>Parent generations<select id="ancestorLevel">${[0,1,2,3,4,5,6].map(n=>`<option value="${n}" ${state.ancestorLevels===n?'selected':''}>${n}</option>`).join('')}</select></label><label>Offspring generations<select id="descendantLevel">${[0,1,2,3,4,5,6].map(n=>`<option value="${n}" ${state.descendantLevels===n?'selected':''}>${n}</option>`).join('')}</select></label><button id="modalHome" type="button">⌂ Roots</button><button id="modalFocus" type="button">◎ Centre on ${esc(full(selected))}</button></div>
    <div class="modal-tree-scroll"><div class="modal-tree-canvas">
      ${ancestors.length?`<div class="lineage-section ancestors"><div class="section-title"><span>ANCESTORS</span><small>${state.ancestorLevels} generation${state.ancestorLevels===1?'':'s'} upward</small></div>${ancestors.map(g=>renderGeneration(g,index,'ancestor')).join('<div class="generation-arrow">↓</div>')}<div class="generation-arrow">↓</div></div>`:''}
      <section class="focus-section modal-focus"><div class="section-title"><span>CENTRE OF THE TREE</span><small>Selected family member</small></div><div class="focus-family"><div class="focus-person">${personCard(selected,{selected:true})}</div>${spouses.length?`<div class="focus-spouses">${spouses.map(s=>`<span class="union">&amp;</span>${personCard(s,{compact:true})}`).join('')}</div>`:''}</div>${selected.notes?`<div class="focus-note">${esc(selected.notes)}</div>`:''}</section>
      ${sibs.length?`<section class="siblings-section"><div class="section-title"><span>SIBLINGS</span><small>Children of the same parent(s)</small></div><div class="sibling-list">${sibs.map(p=>personCard(p,{compact:true})).join('')}</div></section>`:''}
      ${descendants.length?`<div class="lineage-section descendants"><div class="section-title"><span>DESCENDANTS</span><small>${state.descendantLevels} generation${state.descendantLevels===1?'':'s'} downward</small></div>${descendants.map(g=>renderGeneration(g,index,'descendant')).join('<div class="generation-arrow">↓</div>')}</div>`:`<section class="empty-lineage"><h3>No recorded descendants</h3><p>No child relationship is currently recorded for ${esc(full(selected))}.</p></section>`}
    </div></div>
  </div>`;
}
function openTreeModal(personId){
  state.modalOpen=true;const existing=$('#treeModal');if(existing)existing.remove();const wrap=document.createElement('div');wrap.id='treeModal';wrap.className='tree-modal';wrap.innerHTML=renderModalTree(personId);document.body.appendChild(wrap);document.body.classList.add('modal-open');bindModal();}
function bindModal(){
  $('#closeTreeModal').onclick=closeTreeModal;
  $('#treeModal').addEventListener('click',e=>{if(e.target.id==='treeModal')closeTreeModal()},{once:true});
  $('#ancestorLevel').onchange=e=>{state.ancestorLevels=Number(e.target.value);refreshModal()};
  $('#descendantLevel').onchange=e=>{state.descendantLevels=Number(e.target.value);refreshModal()};
  $('#modalHome').onclick=()=>{closeTreeModal();state.selected=state.homeRootId;state.search='';renderTree()};
  $('#modalFocus').onclick=()=>$('#treeModal .modal-focus')?.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});
  document.querySelectorAll('#treeModal [data-node]').forEach(b=>b.onclick=()=>openTreeModal(b.dataset.node));
}
function refreshModal(){const modal=$('#treeModal');if(!modal)return;const id=state.selected;modal.innerHTML=renderModalTree(id);bindModal();}
function closeTreeModal(){const m=$('#treeModal');if(m)m.remove();state.modalOpen=false;document.body.classList.remove('modal-open');}
function personPanel(p){return `<div class="person-panel"><div><span class="pill">${p.source==='excel'?'Excel import':'Family record'}</span><h2>${esc(full(p))}</h2><p>${esc(p.birth_year||'Unknown')}${p.death_year?` — ${esc(p.death_year)}`:''}</p></div><button id="addRelative" type="button">Add relative</button><div id="relativeForm" class="mini-form" style="display:none"><select id="relKind"><option value="child">Add child</option><option value="parent">Add parent</option><option value="spouse">Add spouse</option></select><input id="relName" placeholder="Person's name"><button id="relSubmit" class="primary" type="button">Submit for approval</button></div></div>`}
async function submitRelative(parentId){if(!/^\d{5}$/.test(state.token))return notice('Enter a valid 5-digit contributor token first.');const name=$('#relName').value.trim();if(!name)return;const kind=$('#relKind').value;let payload={given_name:name,notes:'Added through the family archive.'};if(kind==='child')payload.parent_id=parentId;payload.relationship_kind=kind;if(kind!=='child')payload.anchor_id=parentId;try{const r=await api('/api/proposals',{method:'POST',body:JSON.stringify({token:state.token,action:'add_person',payload})});notice(r.message);$('#relName').value=''}catch(e){notice(e.message)}}
async function renderHistory(){let h;try{h=await api('/api/history')}catch{const body=await (await fetch('/history.txt')).text();h={article:{title:'The History of the Asankran Kona Clan',body,source_note:'Source document: Asankra history.pdf'},comments:[]}}state.history=h;const a=h.article||{};$('#main').innerHTML=`<main class="content history"><article class="card"><div class="eyebrow">FAMILY HISTORY</div><h2>${esc(a.title||'The History of the Asankran Kona Clan')}</h2><div class="source-note">${esc(a.source_note||'Source document: Asankra history.pdf')}</div><div class="article-body">${(a.body||'').split(/\n{2,}/).map(x=>`<p>${esc(x.trim())}</p>`).join('')}</div></article><section class="card"><h3>Family comments</h3>${(h.comments||[]).map(c=>`<div class="comment"><strong>${esc(c.author_name)}</strong><span>${new Date(c.created_at).toLocaleDateString()}</span><p>${esc(c.body)}</p></div>`).join('')}<hr><input id="commentAuthor" placeholder="Your name"><textarea id="commentBody" placeholder="Add a family comment…"></textarea><button id="commentBtn" class="primary" type="button">Submit comment</button></section></main>`;$('#commentBtn').onclick=async()=>{if(!/^\d{5}$/.test(state.token))return notice('A valid 5-digit token is required to comment.');try{const r=await api('/api/comment',{method:'POST',body:JSON.stringify({token:state.token,author_name:$('#commentAuthor').value,body:$('#commentBody').value})});notice(r.message);renderHistory()}catch(e){notice(e.message)}}}
function renderContribute(){const people=state.data.people||[];$('#main').innerHTML=`<main class="content"><div class="card"><h2>Contribute to the tree</h2><p>Every change is a proposal. The public tree changes only after administrator approval.</p><label>Action<select id="act"><option value="add_person">Add a person</option><option value="add_relationship">Add a relationship</option><option value="edit_person">Suggest an edit</option><option value="delete_person">Request deletion</option></select></label><label>Existing person<select id="target"><option value="">Choose…</option>${people.map(p=>`<option value="${esc(p.id)}">${esc(full(p))}</option>`).join('')}</select></label><label id="relWrap" style="display:none">Relationship<select id="rel"><option value="parent">parent → child</option><option value="spouse">spouse</option></select></label><label id="nameLabel">New person's name<input id="name" placeholder="Full name"></label><button id="submitProposal" class="primary" type="button">Submit proposal</button></div></main>`;$('#act').onchange=e=>{$('#relWrap').style.display=e.target.value==='add_relationship'?'block':'none';$('#nameLabel').querySelector('input').placeholder=e.target.value==='add_relationship'?'Other person ID':'Full name'};$('#submitProposal').onclick=submitProposal}
async function submitProposal(){if(!/^\d{5}$/.test(state.token))return notice('A valid 5-digit token is required.');const action=$('#act').value,target=$('#target').value,name=$('#name').value.trim();let payload={};if(action==='add_person'){payload={given_name:name};if(target)payload.parent_id=target}else if(action==='add_relationship'){payload={from_person_id:target,to_person_id:name,relationship_type:$('#rel').value}}else{payload={id:target,fields:{given_name:name}}}try{const r=await api('/api/proposals',{method:'POST',body:JSON.stringify({token:state.token,action,payload})});notice(r.message);$('#name').value=''}catch(e){notice(e.message)}}
function renderAdmin(){if(!state.adminSecret)$('#main').innerHTML=`<main class="content admin"><div class="card"><h2>Administrator</h2><p>Enter the Netlify <code>ADMIN_SECRET</code> to manage approvals and contributor tokens.</p><input id="adminSecret" type="password" placeholder="ADMIN_SECRET"><button id="adminOpen" class="primary" type="button">Open moderation queue</button></div></main>`;else loadAdmin();const inp=$('#adminSecret');if(inp)inp.oninput=e=>state.adminSecret=e.target.value;const b=$('#adminOpen');if(b)b.onclick=loadAdmin}
async function loadAdmin(){try{const [q,t]=await Promise.all([api('/api/admin',{headers:{'x-admin-secret':state.adminSecret}}),api('/api/tokens',{headers:{'x-admin-secret':state.adminSecret}})]);$('#main').innerHTML=`<main class="content admin"><div class="card"><h2>Administrator</h2><button id="newToken" class="primary" type="button">Generate 5-digit contributor token</button></div><div class="card"><h3>Pending tree changes</h3>${q.proposals.length?q.proposals.map(p=>queueProposal(p)).join(''):'<p class="muted">No pending tree changes.</p>'}</div><div class="card"><h3>Pending comments</h3>${q.comments.length?q.comments.map(c=>`<div class="queue"><div><b>${esc(c.author_name)}</b><p>${esc(c.body)}</p></div><div><button data-review-kind="comment" data-review-id="${esc(c.id)}" data-status="approved" type="button">Approve</button><button data-review-kind="comment" data-review-id="${esc(c.id)}" data-status="rejected" type="button">Reject</button></div></div>`).join(''):'<p class="muted">No pending comments.</p>'}</div><div class="card"><h3>Contributor tokens</h3>${t.map(x=>`<div class="token-row"><span>${esc(x.label||'Family contributor')}</span><span>${x.active?'Active':'Disabled'}</span><span>${new Date(x.created_at).toLocaleDateString()}</span></div>`).join('')}</div></main>`;document.querySelectorAll('[data-review-id]').forEach(b=>b.onclick=()=>review(b.dataset.reviewKind,b.dataset.reviewId,b.dataset.status));$('#newToken').onclick=async()=>{try{const r=await api('/api/tokens',{method:'POST',headers:{'x-admin-secret':state.adminSecret},body:JSON.stringify({label:'Family contributor'})});notice('New contributor token: '+r.token);loadAdmin()}catch(e){notice(e.message)}}}catch(e){notice(e.message)}}
function queueProposal(p){return `<div class="queue"><div><b>${esc(p.action)}</b><pre>${esc(JSON.stringify(p.payload,null,2))}</pre></div><div><button data-review-kind="proposal" data-review-id="${esc(p.id)}" data-status="approved" type="button">Approve</button><button data-review-kind="proposal" data-review-id="${esc(p.id)}" data-status="rejected" type="button">Reject</button></div></div>`}
async function review(kind,id,status){try{await api('/api/admin',{method:'POST',headers:{'x-admin-secret':state.adminSecret},body:JSON.stringify({kind,id,status})});notice('Review saved.');loadAdmin();loadTree()}catch(e){notice(e.message)}}
loadTree();
