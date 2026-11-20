import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createAcademy} from '../server.mjs';
import {createJuniorAI} from '../junior-ai.mjs';
import {lessons} from '../curriculum.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'academy-support-')),dbPath=join(directory,'academy.sqlite');
let app,base,childId,tutorId;
const calls=[];let outputFlagged=false,providerFails=false;
const fakeFetch=async(url,options)=>{
  const data=JSON.parse(options.body);calls.push({url,data});
  if(providerFails)return {ok:false,status:401};
  return {ok:true,json:async()=>url.endsWith('/moderations')?{results:[{flagged:outputFlagged}]}:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Try labelling one input and one output. What does the keyboard send to your computer?'}]}]}};
};
function client(){const c={cookie:'',csrf:''};c.call=async(path,data)=>{
  const response=await fetch(base+path,{method:data?'POST':'GET',headers:{Origin:'http://localhost:3000',Cookie:c.cookie,'X-CSRF-Token':c.csrf,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  if(response.headers.get('set-cookie'))c.cookie=response.headers.get('set-cookie').split(';')[0];
  const value=await response.json();if(value.csrfToken)c.csrf=value.csrfToken;return{status:response.status,body:value};
};return c;}
const parent=client(),other=client(),student=client(),tutor=client(),guest=client();
async function start(){app=createAcademy({dbPath,allowRegistration:true,adminEmail:'owner@example.test',ai:{key:'test-not-real-api-key',fetch:fakeFetch,zdr:false}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;}
before(async()=>{
  // A database with the v0.1 schema and a user proves the extension is additive.
  const old=new DatabaseSync(dbPath);old.exec('CREATE TABLE parents(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL)');old.prepare('INSERT INTO parents VALUES(?,?,?,?)').run('old-parent','old@example.test','Original parent','not-a-login');old.close();
  await start();
  await parent.call('/api/register',{name:'Owner',email:'owner@example.test',password:'parent secret passphrase'});
  await other.call('/api/register',{name:'Other parent',email:'other@example.test',password:'another parent secret'});
  const child=await parent.call('/api/children',{nickname:'ExplorerPrivateName',username:'private-username',password:'student secret phrase'});childId=child.body.childId;
  await student.call('/api/child-login',{username:'private-username',password:'student secret phrase'});
});
after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
test('existing database rows survive the additive migration; no public admin escalation',async()=>{
  assert.equal(app.db.prepare('SELECT name FROM parents WHERE id=?').get('old-parent').name,'Original parent');
  assert.equal((await parent.call('/api/academy')).body.isAdmin,true);
  assert.equal((await other.call('/api/academy')).body.isAdmin,false);
  assert.equal((await guest.call('/api/academy')).body.isAdmin,false);
  assert.equal((await other.call('/api/admin/tutors',{action:'create',name:'Fake',email:'fake@example.test',password:'fake tutor passphrase'})).status,403);
});
test('only administrator creates tutor; tutor sign-in uses a separate role',async()=>{
  assert.equal((await parent.call('/api/admin/tutors',{action:'create',name:'Tutor One',email:'tutor@example.test',password:'tutor secret phrase'})).status,200);
  tutorId=(await parent.call('/api/academy')).body.admin.tutors[0].id;
  assert.equal((await tutor.call('/api/tutor-login',{email:'tutor@example.test',password:'tutor secret phrase'})).status,200);
  const state=(await tutor.call('/api/academy')).body;assert.equal(state.role,'tutor');assert.equal(state.children.length,0);assert.equal(state.isAdmin,false);
});
test('parents alone grant access; tutor cannot self-assign or manage student credentials',async()=>{
  assert.equal((await other.call('/api/tutor-assignment',{action:'assign',childId,email:'tutor@example.test'})).status,404);
  assert.equal((await tutor.call('/api/tutor-assignment',{action:'assign',childId,email:'tutor@example.test'})).status,403);
  assert.equal((await parent.call('/api/tutor-assignment',{action:'assign',childId,email:'tutor@example.test'})).status,200);
  assert.equal((await tutor.call('/api/academy')).body.children[0].id,childId);
  assert.equal((await tutor.call('/api/child-settings',{childId,password:'unauthorised reset'})).status,403);
  assert.equal((await tutor.call('/api/export')).status,403);
});
test('assigned tutor reviews submitted work and unlocks the next lesson',async()=>{
  for(const stepId of ['a0','a1','a2','b0','b1','b2'])await student.call('/api/progress',{action:'step',week:1,stepId,completed:true});
  await student.call('/api/progress',{action:'quiz',week:1,answer:1});
  assert.equal((await student.call('/api/projects',{week:1,title:'My project',description:'Inputs and outputs.',reflection:'A touchscreen can be both.'})).status,201);
  assert.equal((await tutor.call('/api/review',{childId,week:1,status:'approved',scores:[2,2,2,2,2],feedback:'Good explanation. Try the next week.'})).status,200);
  assert.equal((await student.call('/api/academy')).body.children[0].unlocked,2);
});
test('AI defaults off; students and tutors cannot consent or change limits',async()=>{
  const before=calls.length;
  assert.equal((await student.call('/api/ai/help',{week:1,mode:'explain'})).status,403);
  assert.equal((await tutor.call('/api/ai/settings',{childId,enabled:true,mode:'guided',dailyLimit:20})).status,403);
  assert.equal((await student.call('/api/ai/settings',{childId,enabled:true,mode:'guided',dailyLimit:20})).status,403);
  assert.equal(calls.length,before);
});
test('typed questions fail closed without confirmed project ZDR',async()=>{
  assert.equal((await parent.call('/api/ai/settings',{childId,enabled:true,mode:'chat',dailyLimit:20})).status,403);
  assert.equal((await parent.call('/api/ai/settings',{childId,enabled:true,mode:'guided',dailyLimit:20})).status,200);
  const before=calls.length;
  assert.equal((await student.call('/api/ai/help',{week:1,mode:'chat',message:'Hello'})).status,403);
  assert.equal((await student.call('/api/ai/help',{week:1,mode:'explain',message:'My personal details'})).status,400);
  assert.equal((await student.call('/api/ai/help',{week:24,mode:'explain'})).status,400);
  assert.equal(calls.length,before);
});
test('guided API payload contains no child identity, project work, answer key or secret',async()=>{
  const res=await student.call('/api/ai/help',{week:1,mode:'hint'});assert.equal(res.status,200);
  const payload=calls.find(c=>c.url.endsWith('/responses')).data,serial=JSON.stringify(payload);
  assert.equal(payload.store,false);assert.ok(!('safety_identifier'in payload));
  for(const privateText of [childId,'ExplorerPrivateName','private-username','parent secret','test-not-real-api-key','A touchscreen can be both.','"answer"'])assert.ok(!serial.includes(privateText),privateText);
  const state=(await student.call('/api/academy')).body;assert.equal(state.aiMessages.length,2);assert.equal(state.aiSettings[0].used,1);
  assert.ok(!JSON.stringify(state).includes('test-not-real-api-key'));
});
test('parent and assigned tutor see history; another family cannot access it',async()=>{
  assert.equal((await parent.call(`/api/ai/history?childId=${childId}&week=1`)).body.messages.length,2);
  assert.equal((await tutor.call(`/api/ai/history?childId=${childId}&week=1`)).status,200);
  assert.equal((await other.call(`/api/ai/history?childId=${childId}&week=1`)).status,404);
  assert.equal((await guest.call(`/api/ai/history?childId=${childId}&week=1`)).status,401);
});
test('moderation failure blocks model output and creates an adult check-in marker',async()=>{
  outputFlagged=true;const res=await student.call('/api/ai/help',{week:1,mode:'explain'});outputFlagged=false;
  assert.equal(res.status,200);assert.equal(res.body.flagged,true);assert.match(res.body.text,/trusted adult/);
  assert.ok((await parent.call('/api/academy')).body.aiMessages.some(m=>m.flagged));
});
test('per-student request cap persists; revoked tutor access stops immediately',async()=>{
  await parent.call('/api/ai/settings',{childId,enabled:true,mode:'guided',dailyLimit:2});
  const before=calls.length;
  assert.equal((await student.call('/api/ai/help',{week:1,mode:'explain'})).status,429);assert.equal(calls.length,before);
  await parent.call('/api/tutor-assignment',{action:'revoke',childId,tutorId});
  assert.equal((await tutor.call('/api/academy')).body.children.length,0);
  assert.equal((await tutor.call(`/api/ai/history?childId=${childId}&week=1`)).status,404);
  assert.equal((await tutor.call('/api/review',{childId,week:1,status:'approved',scores:[3,3,3,3,3],feedback:'Not authorised'})).status,404);
});
test('provider failure is generic, not a secret leak; failed attempts count',async()=>{
  await parent.call('/api/ai/settings',{childId,enabled:true,mode:'guided',dailyLimit:5});providerFails=true;
  const res=await student.call('/api/ai/help',{week:1,mode:'explain'});providerFails=false;
  assert.equal(res.status,503);assert.ok(!JSON.stringify(res.body).includes('test-not-real-api-key'));
  assert.equal((await parent.call('/api/academy')).body.aiSettings[0].used,3);
});
test('pausing a tutor revokes sessions; usage and transcripts survive restart',async()=>{
  assert.equal((await parent.call('/api/admin/tutors',{action:'deactivate',tutorId})).status,200);
  assert.equal((await tutor.call('/api/academy')).body.role,'guest');
  await app.close();await start();
  const state=(await parent.call('/api/academy')).body;assert.equal(state.aiSettings[0].used,3);assert.equal(state.projects.length,1);assert.equal(state.aiMessages.length,4);
});
test('transcript retention removes only messages older than 30 days',async()=>{
  app.db.prepare('INSERT INTO ai_messages(child_id,week,role,content,created) VALUES(?,?,?,?,?)').run(childId,1,'user','Old message','2020-01-01T00:00:00.000Z');
  const state=(await parent.call('/api/academy')).body;assert.ok(!state.aiMessages.some(m=>m.content==='Old message'));assert.equal(state.aiMessages.length,4);
});
test('typed mode with ZDR checks both input and output and never gives tools',async()=>{
  const recorded=[];
  const instance=createJuniorAI({key:'test-not-real-api-key',zdr:true,fetch:async(url,opts)=>{recorded.push({url,data:JSON.parse(opts.body)});return{ok:true,json:async()=>url.endsWith('/moderations')?{results:[{flagged:false}]}:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'A loop repeats an instruction. Try repeating a clap three times.'}]}]}};}});
  const result=await instance.reply({lesson:lessons[5],mode:'chat',message:'What is a loop?',history:[],studentId:'local-student'});
  assert.match(result.text,/loop/);assert.equal(recorded.filter(c=>c.url.endsWith('/moderations')).length,2);
  const response=recorded.find(c=>c.url.endsWith('/responses')).data;assert.equal(response.safety_identifier.length,64);assert.equal(response.store,false);assert.ok(!response.tools);
});
test('academy-wide quota prevents extra paid service calls',async()=>{
  const day=new Date().toISOString().slice(0,10);
  app.db.prepare('UPDATE ai_usage SET used=200 WHERE child_id=? AND day=?').run(childId,day);
  const before=calls.length;const res=await student.call('/api/ai/help',{week:1,mode:'hint'});
  assert.equal(res.status,429);assert.match(res.body.error,/academy/);assert.equal(calls.length,before);
});
test('missing moderation results fail closed and never show unreviewed output',async()=>{
  const instance=createJuniorAI({key:'test-not-real-api-key',fetch:async(url)=>({ok:true,json:async()=>url.endsWith('/moderations')?{}:{output:[{type:'message',content:[{type:'output_text',text:'Unreviewed output'}]}]}})});
  await assert.rejects(instance.reply({lesson:lessons[0],mode:'explain'}),/safety check is unavailable/);
});
test('missing key produces an actionable error without making requests',async()=>{
  const instance=createJuniorAI({key:'',fetch:()=>{throw Error('must not call');}});
  assert.equal(instance.configured,false);await assert.rejects(instance.reply({lesson:lessons[0],mode:'explain'}),/not connected/);
});
