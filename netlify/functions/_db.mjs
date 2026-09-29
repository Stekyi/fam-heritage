import pg from 'pg';
import crypto from 'node:crypto';
const { Pool } = pg;
let pool;
export function db(){
  if(!process.env.DATABASE_URL) return null;
  if(!pool) pool=new Pool({connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}, max:5});
  return pool;
}
export function json(statusCode, body){
  return {statusCode, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body:JSON.stringify(body)};
}
export function adminOk(event){
  const supplied=event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  return !!process.env.ADMIN_SECRET && supplied===process.env.ADMIN_SECRET;
}
export function hmacToken(token){
  return crypto.createHmac('sha256',process.env.TOKEN_PEPPER||process.env.ADMIN_SECRET||'change-me').update(String(token)).digest('hex');
}
export function validTokenShape(token){return /^\d{5}$/.test(String(token||''));}
export async function requireToken(event, pool){
  const token=event.headers?.['x-family-token'] || event.body && (()=>{try{return JSON.parse(event.body).token}catch{return ''}})();
  if(!validTokenShape(token)) return null;
  const ip=event.headers?.['x-nf-client-connection-ip'] || event.headers?.['client-ip'] || 'unknown';
  const attempts=await pool.query("select count(*)::int as n from token_attempts where ip=$1 and attempted_at > now()-interval '10 minutes'",[ip]);
  if(attempts.rows[0].n>=30) return null;
  await pool.query('insert into token_attempts(ip) values($1)',[ip]);
  const r=await pool.query('select * from access_tokens where token_hash=$1 and active=true',[hmacToken(token)]);
  if(!r.rows[0]) return null;
  await pool.query('update access_tokens set last_used_at=now() where id=$1',[r.rows[0].id]);
  return r.rows[0];
}
