import fs from 'node:fs';
import pg from 'pg';
const {Pool}=pg;
const DATABASE_URL=process.env.DATABASE_URL;
if(!DATABASE_URL){console.error('DATABASE_URL is required');process.exit(1)}
const pool=new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false}});
const seed=JSON.parse(fs.readFileSync(new URL('../data/seed.json',import.meta.url)));
const merge=JSON.parse(fs.readFileSync(new URL('../data/merge-map.json',import.meta.url)));
const history=fs.readFileSync(new URL('../data/history.txt',import.meta.url),'utf8');

await pool.query(fs.readFileSync(new URL('../netlify/db/001_schema.sql',import.meta.url),'utf8'));
await pool.query('delete from relationships');
await pool.query('delete from people');
await pool.query('delete from articles');

const sourceToDb=new Map();
const htmlById=new Map(seed.html_people.map(p=>[p.id,p]));
const identityMatches=merge.identity_matches||{};
const replacement=merge.excel_root_replacement||{};
const removeHtmlParents=new Set(replacement.remove_html_parent_relationships_for||[]);

function year(v){
  if(!v) return null;
  const years=String(v).match(/(1[5-9]\d{2}|20\d{2})/g);
  return years?.length ? Number(years[0]) : null;
}
function deathYear(v){
  if(!v) return null;
  const years=String(v).match(/(1[5-9]\d{2}|20\d{2})/g);
  return years?.length>1 ? Number(years[years.length-1]) : null;
}
function resolveSourceId(ref){
  if(!ref) return null;
  if(htmlById.has(ref)) return ref;
  if(htmlById.has(`i${ref}`)) return `i${ref}`;
  return null;
}
function splitName(name){
  const s=String(name||'').trim();
  const m=s.match(/^(.+?)\s+([^\s]+)$/);
  return m ? {given:m[1],surname:m[2]} : {given:s,surname:null};
}
function excelDate(name){ return merge.excel_dates?.[name] || null; }

// 1) Load the original HTML tree. Excel-confirmed identities are updated in-place later.
for(const p of seed.html_people){
  const r=await pool.query(`insert into people(given_name,surname,aliases,sex,birth_year,death_year,notes,source,source_ref)
    values($1,$2,$3,$4,$5,$6,$7,'html',$8) returning id`,[
    p.given||'Unknown',p.surname||null,[],p.sex||'U',year(p.birth),year(p.death),p.notes||null,p.id]);
  sourceToDb.set(p.id,r.rows[0].id);
}

// 2) Recreate HTML relationships, resolving the compact Family Echo references.
// The confirmed genealogy keeps Nyantah (Kokoo) -> Ama Buah/Mansa as a parent-child link.
for(const p of seed.html_people){
  const child=sourceToDb.get(p.id); if(!child) continue;
  if(!removeHtmlParents.has(p.id)){
    for(const [kind,parentSourceRaw] of p.parents||[]){
      const parentSource=resolveSourceId(parentSourceRaw);
      const parent=parentSource ? sourceToDb.get(parentSource) : null;
      if(parent) await pool.query(`insert into relationships(from_person_id,to_person_id,relationship_type,status,source,evidence)
        values($1,$2,'parent','approved','html',$3) on conflict do nothing`,[parent,child,p.notes||null]);
    }
  }
  for(const spouseSourceRaw of p.spouses||[]){
    const spouseSource=resolveSourceId(spouseSourceRaw);
    const spouse=spouseSource ? sourceToDb.get(spouseSource) : null;
    if(spouse) await pool.query(`insert into relationships(from_person_id,to_person_id,relationship_type,status,source)
      values($1,$2,'spouse','approved','html') on conflict do nothing`,[child,spouse]);
  }
}

// 3) Merge Excel identities. A matched Excel person reuses the existing DB identity;
// Excel is authoritative for the confirmed Mansa branch names/dates/details.
const excelDb=new Map();
const excelNameDb=new Map();
for(const p of seed.excel_people){
  const match=identityMatches[p.name];
  if(match?.html_id && sourceToDb.has(match.html_id)){
    const dbId=sourceToDb.get(match.html_id);
    const canonical=match.canonical_name || p.name;
    const name=splitName(canonical);
    const dates=excelDate(p.name) || p.dates;
    const aliases=[...(match.aliases||[])];
    const original=htmlById.get(match.html_id);
    if(original){
      const originalName=[original.given,original.surname].filter(Boolean).join(' ');
      if(originalName && originalName!==canonical) aliases.push(originalName);
    }
    const uniqueAliases=[...new Set(aliases.filter(Boolean))];
    const notes=[original?.notes,p.notes,match.reason].filter(Boolean).join(' ');
    await pool.query(`update people set given_name=$1,surname=$2,aliases=$3,birth_year=$4,death_year=$5,notes=$6,source='excel',source_ref=$7,updated_at=now() where id=$8`,[
      name.given,name.surname,uniqueAliases,year(dates),deathYear(dates),notes,`${p.id};${match.html_id}`,dbId]);
    excelDb.set(p.id,dbId);
    excelNameDb.set(p.name,dbId);
    continue;
  }

  // Avoid duplicate Excel records such as the repeated Kwaku Buafo node.
  // The workbook contains one known duplicate rendering of the top Kwaku node.
  // Do not collapse other equal names automatically because two relatives may share a name.
  if(p.id==='excel-003' && excelNameDb.has('Kwaku Buafo (Opayin Kankyea)')){
    excelDb.set(p.id,excelNameDb.get('Kwaku Buafo (Opayin Kankyea)'));
    continue;
  }
  const dates=excelDate(p.name) || p.dates;
  const name=splitName(p.name);
  const r=await pool.query(`insert into people(given_name,surname,aliases,sex,birth_year,death_year,notes,source,source_ref)
    values($1,$2,$3,'U',$4,$5,$6,'excel',$7) returning id`,[
    name.given,name.surname,[],year(dates),deathYear(dates),p.notes||'Imported from the Kankyea and Mansa Excel family tree.',p.id]);
  excelDb.set(p.id,r.rows[0].id);
  excelNameDb.set(p.name,r.rows[0].id);
}

const findExcel=n=>excelNameDb.get(n)||null;

// 4) Add the Excel-confirmed spouse relationship and Excel branch details.
// Ama Buah/Mansa remains the child of Nyantah (Kokoo); Kwaku Buafo is her spouse/partner.
const topA=findExcel('Kwaku Buafo (Opayin Kankyea)');
const topB=findExcel('Ama Buah (Nana Mansa)');
if(topA&&topB){
  await pool.query(`insert into relationships(from_person_id,to_person_id,relationship_type,status,source,evidence)
    values($1,$2,'spouse','approved','excel','Top couple shown together in the uploaded Excel tree.') on conflict do nothing`,[topA,topB]);
}

// Children shown beneath the Excel couple are children of both Kwaku Buafo and Ama Buah.
for(const childName of replacement.top_couple_children||[]){
  const child=findExcel(childName);
  if(!child) continue;
  for(const parent of [topA,topB]) if(parent){
    await pool.query(`insert into relationships(from_person_id,to_person_id,relationship_type,status,source,evidence)
      values($1,$2,'parent','approved','excel','Top couple and child relationship shown in uploaded Excel family tree.') on conflict do nothing`,[parent,child]);
  }
}

// 5) Import the remaining visually clear Excel parent-child chains.
// If the same child already has a different approved parent, leave a proposal instead of overwriting it.
for(const p of seed.excel_people){
  if(!p.parent_name) continue;
  const parent=findExcel(p.parent_name), child=excelDb.get(p.id);
  if(!parent||!child) continue;
  const existing=await pool.query(`select r.id,r.from_person_id from relationships r where r.to_person_id=$1 and r.relationship_type='parent' and r.status='approved'`,[child]);
  if(existing.rows.length && !existing.rows.some(x=>x.from_person_id===parent)){
    // Do not create a duplicate proposal when the same relationship is already pending.
    const pending=await pool.query(`select 1 from proposals where status='pending' and action='add_relationship' and payload->>'from_person_id'=$1 and payload->>'to_person_id'=$2`,[parent,child]);
    if(!pending.rows.length){
      await pool.query(`insert into proposals(action,payload,token_label) values('add_relationship',$1,'Excel import')`,[JSON.stringify({from_person_id:parent,to_person_id:child,relationship_type:'parent',source:'excel',reason:'Conflicts with an existing approved parent relationship from the main tree.'})]);
    }
  } else {
    await pool.query(`insert into relationships(from_person_id,to_person_id,relationship_type,status,source,evidence)
      values($1,$2,'parent','approved','excel','Visually clear parent-child chain in uploaded Excel tree.') on conflict do nothing`,[parent,child]);
  }
}

await pool.query(`insert into articles(slug,title,body,source_note)
  values('asankran-history','The History of the Asankran Kona Clan',$1,$2)
  on conflict(slug) do update set body=excluded.body,source_note=excluded.source_note,updated_at=now()`,[
  history,'Transcribed from the uploaded “Asankra history.pdf”, by E.B. Cudjoe (November 2017). The article is presented as a family-history source; disputed or uncertain statements should remain attributed to the source.']);

console.log(`Seeded ${seed.html_people.length} main records and merged ${seed.excel_people.length} Excel records.`);
await pool.end();
