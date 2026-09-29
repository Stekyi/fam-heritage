import {db,json,requireToken} from './_db.mjs';
export async function handler(event){
  const pool=db(); if(!pool) return json(503,{error:'Database is not configured.'});
  const token=await requireToken(event,pool); if(!token) return json(401,{error:'A valid 5-digit family token is required.'});
  if(event.httpMethod==='GET'){
    const r=await pool.query("select id,action,payload,status,token_label,submitted_at,reviewed_at,review_note from proposals where status='pending' order by submitted_at desc");
    return json(200,r.rows);
  }
  if(event.httpMethod!=='POST') return json(405,{error:'Method not allowed'});
  let body={}; try{body=JSON.parse(event.body||'{}')}catch{return json(400,{error:'Invalid JSON'})}
  const allowed=['add_person','edit_person','delete_person','add_relationship','delete_relationship'];
  if(!allowed.includes(body.action) || !body.payload) return json(400,{error:'Invalid proposal'});
  const r=await pool.query('insert into proposals(action,payload,token_label) values($1,$2,$3) returning id',[body.action,body.payload,token.label||null]);
  return json(201,{ok:true,id:r.rows[0].id,message:'Submitted for admin approval.'});
}
