import {db,json,adminOk} from './_db.mjs';
export async function handler(event){
 const pool=db(); if(!pool) return json(503,{error:'Database is not configured.'});
 if(!adminOk(event)) return json(403,{error:'Admin authentication required.'});
 if(event.httpMethod==='GET'){
   const [p,c]=await Promise.all([
    pool.query("select * from proposals where status='pending' order by submitted_at desc"),
    pool.query("select c.*,a.slug from comments c join articles a on a.id=c.article_id where c.status='pending' order by c.created_at desc")
   ]);
   return json(200,{proposals:p.rows,comments:c.rows});
 }
 if(event.httpMethod!=='POST') return json(405,{error:'Method not allowed'});
 let b={}; try{b=JSON.parse(event.body||'{}')}catch{return json(400,{error:'Invalid JSON'})}
 if(b.kind==='comment'){
   if(!['approved','rejected'].includes(b.status)) return json(400,{error:'Invalid status'});
   await pool.query('update comments set status=$1,reviewed_at=now(),reviewed_by=$2 where id=$3',[b.status,'admin',b.id]);
   return json(200,{ok:true});
 }
 if(b.kind==='proposal'){
   const q=await pool.query('select * from proposals where id=$1',[b.id]);
   const pr=q.rows[0]; if(!pr) return json(404,{error:'Proposal not found'});
   if(b.status==='rejected'){
     await pool.query('update proposals set status=$1,reviewed_at=now(),reviewed_by=$2,review_note=$3 where id=$4',['rejected','admin',b.note||null,b.id]);
     return json(200,{ok:true});
   }
   if(b.status!=='approved') return json(400,{error:'Invalid status'});
   const p=pr.payload;
   if(pr.action==='add_person'){
     const ins=await pool.query('insert into people(given_name,surname,aliases,sex,birth_year,death_year,notes,source,source_ref) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',[p.given_name,p.surname||null,p.aliases||[],p.sex||'U',p.birth_year||null,p.death_year||null,p.notes||null,'contributor',pr.id]);
     const newId=ins.rows[0].id;
     if(p.parent_id) await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,'parent','approved','contributor',$3)",[p.parent_id,newId,'admin']);
     if(p.anchor_id && p.relationship_kind==='parent') await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,'parent','approved','contributor',$3)",[newId,p.anchor_id,'admin']);
     if(p.anchor_id && p.relationship_kind==='spouse') await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,'spouse','approved','contributor',$3) on conflict do nothing",[newId,p.anchor_id,'admin']);
   } else if(pr.action==='edit_person'){
     const f=p.fields||{}; const allowed=['given_name','surname','sex','birth_year','death_year','notes','aliases','photo_url'];
     const sets=[]; const vals=[]; let n=1; for(const k of allowed){if(k in f){sets.push(`${k}=$${n++}`);vals.push(f[k]);}}
     if(sets.length){vals.push(p.id);await pool.query(`update people set ${sets.join(',')},updated_at=now() where id=$${n}`,vals)}
   } else if(pr.action==='delete_person'){
     await pool.query('delete from people where id=$1',[p.id]);
   } else if(pr.action==='add_relationship'){
     await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,$3,'approved',$4,$5) on conflict do nothing",[p.from_person_id,p.to_person_id,p.relationship_type,'contributor',pr.id]);
   } else if(pr.action==='delete_relationship'){
     await pool.query('delete from relationships where id=$1',[p.id]);
   }
   await pool.query('update proposals set status=$1,reviewed_at=now(),reviewed_by=$2,review_note=$3 where id=$4',['approved','admin',b.note||null,b.id]);
   return json(200,{ok:true});
 }
 return json(400,{error:'Unknown admin action'});
}
