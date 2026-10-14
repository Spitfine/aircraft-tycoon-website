// Interactive rendering and EN/PT-PT dictionary from the reviewed Pioneer snapshot.

(()=>{
const root=document.getElementById('pioneer-complete');
const data=JSON.parse(document.getElementById('pc-data').textContent);
const byId=new Map(data.nodes.map(n=>[n.id,n]));
const laneHost=root.querySelector('#pc-lanes'),cross=root.querySelector('#pc-cross-links'),canvas=root.querySelector('#pc-canvas');
const NS='http://www.w3.org/2000/svg',CAT=174,PW=1652,FW=160,NW=194,NH=148,DX=216,DY=178,TOP=48,LEFT=20,HEADER=98;
const elements=new Map(),positions=new Map(),laneInfo=new Map(),paths=[];
let selected=null,totalY=HEADER;
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function marker(svg,id,color){const defs=document.createElementNS(NS,'defs'),m=document.createElementNS(NS,'marker');m.id=id;m.setAttribute('viewBox','0 0 10 10');m.setAttribute('refX','9');m.setAttribute('refY','5');m.setAttribute('markerWidth','5');m.setAttribute('markerHeight','5');m.setAttribute('orient','auto');const p=document.createElementNS(NS,'path');p.setAttribute('d','M0 1 L9 5 L0 9 Z');p.setAttribute('fill',color);m.append(p);defs.append(m);svg.append(defs);}
marker(cross,'pc-arrow-cross','#e2bc72');
data.eras.slice(1).forEach((name,i)=>{const e=el('div','pc-era');e.append(el('span','',String(i+2).padStart(2,'0')),el('strong','',name),el('small','','Conteúdo por definir'));root.querySelector('#pc-future-heads').append(e);});
function sourceLabel(id){return id.startsWith('E-')?'Established':id==='FLOAT'?'Componente existente':id;}
function physicalLabel(n){if(!n.gates?.length)return '';const g=n.gates[0];if(g.includes('histórica'))return 'Elegibilidade histórica';if(g.includes('Túnel'))return g.includes('L2')?'Instalação: túnel ≥ L2':g.includes('L1')?'Instalação: túnel ≥ L1':'Instalação: túnel operacional';if(g.includes('Test Stand'))return 'Instalação: bancada operacional';if(g.includes('Hangar'))return n.id==='RI-07'?'Instalação: Hangar 12 Workers':'Instalação: Hangar operacional';if(g.includes('Office'))return n.id==='RI-09'?'Instalação: Office melhorado':'Instalação: Office operacional';return 'Instalação: R&D operacional';}
data.categories.forEach(c=>{
const nodes=data.nodes.filter(n=>n.category===c.id);const height=(Math.max(...nodes.map(n=>n.y))+1)*DY+TOP+26;
const lane=el('section','pc-lane');lane.id='pc-lane-'+c.id;lane.style.height=height+'px';lane.setAttribute('aria-label',c.name);
const label=el('div','pc-category-label');label.append(el('h2','',c.name),el('p','pc-count',c.count+' nós'),el('p','pc-status',c.status));
const branch=el('div','pc-branch');const svg=document.createElementNS(NS,'svg');svg.setAttribute('class','pc-local-links');svg.setAttribute('width',PW);svg.setAttribute('height',height);svg.setAttribute('aria-hidden','true');marker(svg,'pc-arrow-'+c.id,'#c79a47');branch.append(svg);
laneInfo.set(c.id,{top:totalY,height,svg,lane});
nodes.forEach(n=>{const x=LEFT+n.x*DX,y=TOP+n.y*DY;positions.set(n.id,{x,y,gx:CAT+x,gy:totalY+y,category:c.id});const b=el('button','pc-node '+n.kind+(['FC','LG'].includes(c.id)&&n.kind==='research'?' pending':''));b.type='button';b.style.left=x+'px';b.style.top=y+'px';b.setAttribute('aria-pressed','false');b.setAttribute('aria-label',n.id+' — '+n.name);b.dataset.node=n.id;b.append(el('span','pc-id',n.kind==='established'?'ESTABLISHED':n.kind==='component'?'COMPONENTE EXISTENTE':n.id),el('span','pc-name',n.name));let req=n.kind==='established'?'Base inicial · não é Research':n.kind==='component'?'Experimental · disponível em 1910':n.parents.length?(n.logic==='any'?'OU: ':n.parents.length>1?'E: ':'Requer: ')+n.parents.map(sourceLabel).join(n.logic==='any'?' / ':' + '):'Requisitos gerais de R&D';b.append(el('span','pc-requires',req));if(physicalLabel(n))b.append(el('span','pc-physical',physicalLabel(n)));b.addEventListener('click',()=>inspect(n.id));branch.append(b);elements.set(n.id,b);});
lane.append(label,branch);for(let i=0;i<5;i++){const f=el('div','pc-future-cell');f.append(el('span','','Por definir'));lane.append(f);}laneHost.append(lane);const op=el('option','',c.name);op.value=c.id;root.querySelector('#pc-category').append(op);totalY+=height;
});
for(const [name,copy] of [['Roles','10 funções de missão definidas; ainda sem nós de Research.'],['Mission Equipment','Exploração conceptual; ainda sem árvore de Research definida.']]){const row=el('section','pc-lane');row.style.minHeight='100px';const label=el('div','pc-category-label');label.append(el('h2','',name));const content=el('div','pc-branch pc-open',copy);row.append(label,content);for(let i=0;i<5;i++)row.append(el('div','pc-future-cell','Por definir'));laneHost.append(row);totalY+=100;}
canvas.style.width=CAT+PW+5*FW+'px';cross.setAttribute('width',CAT+PW+5*FW);cross.setAttribute('height',totalY);
function addPath(from,to,type,index){const s=positions.get(from),t=positions.get(to);if(!s||!t)return;const same=s.category===t.category;const svg=same?laneInfo.get(t.category).svg:cross;const p=document.createElementNS(NS,'path');p.setAttribute('class','pc-path '+(same?'': 'cross ')+type);let d;if(same){const sx=s.x+NW,sy=s.y+NH/2,tx=t.x,ty=t.y+NH/2,gap=10+(index%3)*3;if(Math.abs(s.y-t.y)<1&&t.x>s.x&&t.x-s.x<DX+1)d=`M${sx} ${sy} H${tx-4}`;else{const channel=s.y+NH+14+(index%2)*4;d=`M${sx} ${sy} H${sx+gap} V${channel} H${tx-9} V${ty} H${tx-4}`;}}else{const right=CAT+PW-16-(index%12)*5;const exit=laneInfo.get(s.category).top+laneInfo.get(s.category).height-16-(index%3)*4;const entry=laneInfo.get(t.category).top+18+(index%4)*5;d=`M${s.gx+NW} ${s.gy+NH/2} H${s.gx+NW+12} V${exit} H${right} V${entry} H${t.gx-9} V${t.gy+NH/2} H${t.gx-4}`;}
p.setAttribute('d',d);p.setAttribute('marker-end','url(#'+(same?'pc-arrow-'+t.category:'pc-arrow-cross')+')');svg.append(p);paths.push({element:p,from,to,type,same});}
let ix=0;for(const n of data.nodes){n.parents.forEach(id=>addPath(id,n.id,id==='FLOAT'?'context':'hard',ix++));(n.support??[]).forEach(id=>addPath(id,n.id,'support',ix++));}
function highlight(id){selected=id;const related=new Set([id]);paths.forEach(p=>{const active=p.from===id||p.to===id;if(active){related.add(p.from);related.add(p.to);}p.element.classList.toggle('highlight',!!id&&active);p.element.classList.toggle('dim',!!id&&!active);});elements.forEach((b,key)=>{b.setAttribute('aria-pressed',String(key===id));b.classList.toggle('related',!!id&&key!==id&&related.has(key));});}
const dialog=root.querySelector('#pc-inspector');
function inspect(id){const n=byId.get(id);if(!n)return;highlight(id);root.querySelector('#pc-inspector-id').textContent=n.kind==='research'?n.id+' · '+n.status:n.kind==='established'?'ESTABLISHED · conhecimento inicial':'Componente existente · não é Research';root.querySelector('#pc-inspector-title').textContent=n.name;const body=root.querySelector('#pc-inspector-body');body.replaceChildren();
function group(title,ids){if(!ids.length)return;body.append(el('h3','',title));ids.forEach(pid=>{const pn=byId.get(pid),b=el('button','pc-parent',sourceLabel(pid)+' — '+pn.name);b.type='button';b.addEventListener('click',()=>inspect(pid));body.append(b);});}
group(n.logic==='any'?'Pré-requisitos: basta UM (OU)':'Pré-requisitos: TODOS (E)',n.parents);if(n.kind==='research'&&!n.parents.length)body.append(el('p','','Sem pré-requisito de Research específico; aplicam-se os meios gerais de R&D e os requisitos físicos indicados.'));
group('Conhecimento de apoio — não é obrigatório',n.support??[]);group('Abre conhecimento para',data.nodes.filter(other=>other.parents.includes(id)).map(other=>other.id));
if(n.gates?.length){body.append(el('h3','','Requisitos físicos / elegibilidade'));n.gates.forEach(g=>body.append(el('p','',g)));}
if(n.note){body.append(el('h3','','Limites e distinções'));body.append(el('p','',n.note));}
if(n.kind==='research')body.append(el('p','','Concluir investigação não instala equipamento nem produz evidência de testes. Aplicam-se os requisitos gerais de R&D, recursos e pessoal.'));
if(!dialog.open)dialog.showModal();}
root.querySelector('#pc-close').addEventListener('click',()=>dialog.close());
const viewport=root.querySelector('.pc-scroll'),zoomLevel=root.querySelector('#pc-zoom-level'),zoomOut=root.querySelector('#pc-zoom-out'),zoomIn=root.querySelector('#pc-zoom-in');
let scale=1,gesture=null,suppressClick=false;
function setZoom(value,anchorX=viewport.clientWidth/2,anchorY=viewport.clientHeight/2){
 const next=Math.max(.4,Math.min(1.8,Math.round(value*100)/100));
 const worldX=(viewport.scrollLeft+anchorX)/scale,worldY=(viewport.scrollTop+anchorY)/scale;
 scale=next;canvas.style.zoom=String(scale);
 viewport.scrollLeft=worldX*scale-anchorX;viewport.scrollTop=worldY*scale-anchorY;
 zoomLevel.textContent=Math.round(scale*100)+'%';zoomOut.disabled=scale<=.4;zoomIn.disabled=scale>=1.8;
 root.dataset.zoom=String(scale);
}
zoomOut.addEventListener('click',()=>setZoom(scale-.1));
zoomIn.addEventListener('click',()=>setZoom(scale+.1));
root.querySelector('#pc-zoom-reset').addEventListener('click',()=>setZoom(1));
viewport.addEventListener('wheel',e=>{
 if(gesture)return;e.preventDefault();
 const r=viewport.getBoundingClientRect(),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?viewport.clientHeight:1);
 setZoom(scale*Math.exp(-Math.max(-200,Math.min(200,delta))*.0015),e.clientX-r.left-viewport.clientLeft,e.clientY-r.top-viewport.clientTop);
},{passive:false});
viewport.addEventListener('pointerdown',e=>{
 if(e.pointerType!=='mouse'||e.button!==0||e.target.closest('a'))return;
 const r=viewport.getBoundingClientRect();
 if(e.clientX-r.left>=viewport.clientWidth||e.clientY-r.top>=viewport.clientHeight)return;
 suppressClick=false;gesture={id:e.pointerId,x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop,dragged:false};
});
viewport.addEventListener('pointermove',e=>{
 if(!gesture||e.pointerId!==gesture.id)return;
 const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
 if(!gesture.dragged&&Math.hypot(dx,dy)<5)return;
 if(!gesture.dragged){gesture.dragged=true;viewport.setPointerCapture(e.pointerId);viewport.classList.add('pc-dragging');}
 e.preventDefault();viewport.scrollLeft=gesture.left-dx;viewport.scrollTop=gesture.top-dy;
});
function endPan(e){
 if(!gesture||e.pointerId!==gesture.id)return;
 suppressClick=gesture.dragged;gesture=null;viewport.classList.remove('pc-dragging');
 if(viewport.hasPointerCapture(e.pointerId))viewport.releasePointerCapture(e.pointerId);
}
viewport.addEventListener('pointerup',endPan);viewport.addEventListener('pointercancel',endPan);viewport.addEventListener('lostpointercapture',endPan);
viewport.addEventListener('pointerleave',e=>{if(gesture&&!gesture.dragged)endPan(e);});
viewport.addEventListener('click',e=>{if(suppressClick&&e.detail!==0){e.preventDefault();e.stopImmediatePropagation();suppressClick=false;}},true);
viewport.addEventListener('dragstart',e=>e.preventDefault());
function locate(id){const p=positions.get(id),b=elements.get(id);if(!p||!b)return;viewport.scrollLeft=Math.max(0,(p.gx+NW/2)*scale-(viewport.clientWidth+(getComputedStyle(root.querySelector('.pc-category-label')).position==='sticky'?CAT*scale:0))/2);viewport.scrollTop=Math.max(0,(p.gy+NH/2)*scale-viewport.clientHeight/2);b.focus({preventScroll:true});}
root.querySelector('#pc-locate').addEventListener('click',()=>{dialog.close();locate(selected);});
root.querySelector('#pc-category').addEventListener('change',e=>{if(!e.target.value)return;viewport.scrollTop=laneInfo.get(e.target.value).top*scale;viewport.scrollLeft=0;});
root.querySelector('#pc-reset').addEventListener('click',()=>highlight(null));
root.querySelector('#pc-support-toggle').addEventListener('change',e=>paths.forEach(p=>{if(p.type==='support')p.element.classList.toggle('pc-hidden',!e.target.checked);}));
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
root.dataset.researchCount=String(data.nodes.filter(n=>n.kind==='research').length);root.dataset.edgeCount=String(paths.length);
})();


(()=>{
 const root=document.getElementById('pioneer-complete');
 const dictionary=JSON.parse(document.getElementById('pc-translations').textContent);
 const picker=root.querySelector('#pc-language');
 const originals=new WeakMap(),attributes=new WeakMap();
 let language='en-GB';
 const supported=value=>value==='pt-PT'||value==='en-GB';
 try { language=localStorage.getItem('aircraftTycoonWebsiteLanguage')==='pt'?'pt-PT':'en-GB'; } catch (_) {}
 function translated(source){
  const key=source.trim(),entry=dictionary[key];
  return entry?source.replace(key,entry[language==='pt-PT'?1:0]):source;
 }
 function apply(){
  observer.disconnect();
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()){
   if(node.parentElement.closest('script,style,#pc-language'))continue;
   const previous=originals.get(node);
   const source=previous&&node.nodeValue===previous.result?previous.source:node.nodeValue;
   const result=translated(source);
   if(node.nodeValue!==result)node.nodeValue=result;
   originals.set(node,{source,result});
  }
  for(const element of [root,...root.querySelectorAll('[aria-label]')]){
   const current=element.getAttribute('aria-label');if(!current)continue;
   const previous=attributes.get(element),source=previous&&current===previous.result?previous.source:current,result=translated(source);
   if(current!==result)element.setAttribute('aria-label',result);
   attributes.set(element,{source,result});
  }
  root.lang=language;root.dataset.language=language;picker.value=language;
  document.documentElement.lang=language;
  document.title=language==='pt-PT'?'Árvore Pioneer — pré-visualização conceptual | Aircraft Tycoon':'Pioneer Research Tree — Concept Preview | Aircraft Tycoon';
  document.querySelectorAll('[data-site-language]').forEach(element=>{element.hidden=element.dataset.siteLanguage!==(language==='pt-PT'?'pt':'en');});
  document.querySelector('.research-nav').setAttribute('aria-label',language==='pt-PT'?'Navegação principal':'Main navigation');
  observer.observe(root,{childList:true,subtree:true,characterData:true});
 }
 const observer=new MutationObserver(apply);
 picker.addEventListener('change',()=>{
  language=picker.value;apply();
  try { localStorage.setItem('aircraftTycoonWebsiteLanguage',language==='pt-PT'?'pt':'en'); } catch (_) {}
 });

 apply();
})();
