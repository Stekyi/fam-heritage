import {db,json,adminOk,hmacToken} from './_db.mjs';
import crypto from 'node:crypto';
function newToken(){return String(crypto.randomInt(0,100000)).padStart(5,'0')}
export async function handler(event){
 const pool=db(); if(!pool) return json(503,{error:'Database is not configured.'});
 if(!adminOk(event)) return json(403,{error:'Admin authentication required.'});
 if(event.httpMethod==='GET'){
  const r=await pool.query('select id,label,active,created_at,last_used_at from access_tokens order by created_at desc');
  return json(200,r.rows);
 }
 if(event.httpMethod==='POST'){
  let body={}; try{body=JSON.parse(event.body||'{}')}catch{}
  let token; let tries=0;
  do {token=newToken(); const q=await pool.query('select 1 from access_tokens where token_hash=$1',[hmacToken(token)]); if(!q.rowCount) break; tries++;} while(tries<20);
  await pool.query('insert into access_tokens(token_hash,label) values($1,$2)',[hmacToken(token),body.label||'Family contributor']);
  return json(201,{token,label:body.label||'Family contributor'});
 }
 if(event.httpMethod==='PATCH'){
  let body={}; try{body=JSON.parse(event.body||'{}')}catch{}
  if(!body.id) return json(400,{error:'Missing token id'});
  await pool.query('update access_tokens set active=$1 where id=$2',[body.active!==false,body.id]);
  return json(200,{ok:true});
 }
 return json(405,{error:'Method not allowed'});
}
