import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcademy } from '../server.mjs';
import { lessons, publicLessons } from '../curriculum.mjs';

let app, base, childId, fileId;
const directory = mkdtempSync(join(tmpdir(), 'academy-test-'));
const dbPath = join(directory, 'test.sqlite');
const origin = 'http://localhost:3000';
async function start() {
  app = createAcademy({ dbPath, origin, allowRegistration:true });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
function client() {
  const result = { cookie:'', csrf:'' };
  result.call = async (path, data, options = {}) => {
    const headers = { Origin:origin, Cookie:result.cookie, 'X-CSRF-Token':result.csrf, ...options.headers };
    if (data && !options.raw) headers['Content-Type']='application/json';
    const response = await fetch(base+path, { method:data ? 'POST':'GET', headers, body:data ? options.raw ? data : JSON.stringify(data) : undefined });
    if (response.headers.get('set-cookie')) result.cookie=response.headers.get('set-cookie').split(';')[0];
    const isJson=response.headers.get('content-type')?.includes('application/json');
    const body=isJson ? await response.json() : Buffer.from(await response.arrayBuffer());
    if (body.csrfToken) result.csrf=body.csrfToken;
    return { status:response.status, body, headers:response.headers };
  };
  return result;
}
const parent=client(), other=client(), student=client(), guest=client();
before(start);
after(async()=>{ await app.close(); rmSync(directory,{recursive:true,force:true}); });

test('24 complete lessons, 48 sessions, valid quizzes and six milestones',()=>{
  assert.equal(lessons.length,24); assert.equal(lessons.filter(l=>l.milestone).length,6);
  for (const l of lessons) {
    assert.equal(l.sessionA.steps.length,3); assert.equal(l.sessionB.steps.length,3);
    assert.ok(l.quiz.options[l.quiz.answer]); assert.ok(l.output && l.assessment && l.teachingNotes);
  }
  assert.ok(publicLessons.every(l=>!('answer' in l.quiz)));
});
test('guest sees curriculum but no family data or answer keys',async()=>{
  const res=await guest.call('/api/academy'); assert.equal(res.status,200);
  assert.equal(res.body.role,'guest'); assert.deepEqual(res.body.children,[]);
  assert.ok(res.body.lessons.every(l=>!('answer' in l.quiz)));
  assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await guest.call('/api/export')).status,401);
});
test('cross-origin registration and malformed payloads are rejected',async()=>{
  assert.equal((await guest.call('/api/register',{name:'A',email:'a@test.example',password:'secure passphrase'},{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await guest.call('/api/register',{name:'A',email:'bad',password:'secure passphrase'})).status,400);
});
test('parent accounts are real, passwords hashed and responses private',async()=>{
  assert.equal((await parent.call('/api/register',{name:'Parent A',email:'parent-a@test.example',password:'a strong parent passphrase'})).status,201);
  assert.equal((await other.call('/api/register',{name:'Parent B',email:'parent-b@test.example',password:'another parent passphrase'})).status,201);
  assert.equal((await parent.call('/api/academy')).body.role,'parent');
  const stored=app.db.prepare('SELECT password FROM parents LIMIT 1').get().password;
  assert.match(stored,/^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.ok(!JSON.stringify((await parent.call('/api/academy')).body).includes(stored));
});
test('create student and require CSRF for parent changes',async()=>{
  const payload={nickname:'Explorer',username:'little-explorer',password:'student secret phrase'};
  assert.equal((await parent.call('/api/children',payload,{headers:{'X-CSRF-Token':'wrong'}})).status,403);
  const res=await parent.call('/api/children',payload); assert.equal(res.status,201); childId=res.body.childId;
  assert.equal((await other.call('/api/academy')).body.children.length,0);
});
test('students have separate sessions and cannot call parent endpoints',async()=>{
  assert.equal((await student.call('/api/child-login',{username:'little-explorer',password:'student secret phrase'})).status,200);
  const s=await student.call('/api/academy'); assert.equal(s.body.role,'child'); assert.equal(s.body.children.length,1);
  assert.equal((await student.call('/api/children',{nickname:'Other',username:'fake-student',password:'not a valid parent'})).status,403);
  assert.equal((await student.call('/api/review',{childId,week:1,status:'approved',scores:[3,3,3,3,3],feedback:'Bypass'})).status,403);
  assert.equal((await student.call('/api/export')).status,403);
});
test('cross-family profile access and locked week tampering fail',async()=>{
  assert.equal((await other.call('/api/child-settings',{childId,nickname:'Stolen',schedule:'',unlocked:24})).status,404);
  assert.equal((await student.call('/api/progress',{action:'step',week:2,stepId:'a0',completed:true})).status,400);
  assert.equal((await student.call('/api/progress',{action:'step',week:1,stepId:'fake',completed:true})).status,400);
});
test('knowledge check is verified on server; incomplete submissions fail',async()=>{
  const incorrect=await student.call('/api/progress',{action:'quiz',week:1,answer:0}); assert.equal(incorrect.body.passed,false);
  assert.equal((await student.call('/api/projects',{week:1,title:'Bypass',description:'not finished',reflection:'not yet',quizPassed:true})).status,400);
  for (const stepId of ['a0','a1','a2','b0','b1','b2']) assert.equal((await student.call('/api/progress',{action:'step',week:1,stepId,completed:true})).status,200);
  assert.equal((await student.call('/api/progress',{action:'quiz',week:1,answer:1})).body.passed,true);
});
test('private files enforce allowed types, signatures and family ownership',async()=>{
  assert.equal((await student.call('/api/upload?week=1&name=bad.png',Buffer.from('not a png'),{raw:true})).status,400);
  assert.equal((await student.call('/api/upload?week=1&name=bad.html',Buffer.from('<script>bad</script>'),{raw:true})).status,400);
  const res=await student.call('/api/upload?week=1&name=computer-map.txt',Buffer.from('Keyboard = input. Screen = output.'),{raw:true});
  assert.equal(res.status,201); fileId=res.body.fileId;
  assert.equal((await other.call('/api/files/'+fileId)).status,404);
  assert.equal((await guest.call('/api/files/'+fileId)).status,401);
  const file=await parent.call('/api/files/'+fileId); assert.equal(file.status,200); assert.match(file.headers.get('content-disposition'),/^attachment/);
  assert.equal(file.body.toString(),'Keyboard = input. Screen = output.');
});
test('project persists; unsafe links fail; submitted work becomes read-only',async()=>{
  const project={week:1,title:'My computer map',description:'I labelled inputs and outputs.',reflection:'A touchscreen does both.',fileId};
  assert.equal((await student.call('/api/projects',{...project,link:'javascript:alert(1)'})).status,400);
  assert.equal((await student.call('/api/projects',project)).status,201);
  assert.equal((await student.call('/api/progress',{action:'step',week:1,stepId:'a0',completed:false})).status,409);
  assert.equal((await student.call('/api/projects',project)).status,409);
  assert.equal((await parent.call('/api/academy')).body.projects[0].title,project.title);
});
test('feedback, revision history and approval unlock next week',async()=>{
  const review={childId,week:1,scores:[2,2,2,2,3],feedback:'Great map. Add storage next.'};
  assert.equal((await parent.call('/api/review',{...review,status:'changes_requested'})).status,200);
  assert.equal((await student.call('/api/academy')).body.progress[0].feedback,review.feedback);
  assert.equal((await student.call('/api/projects',{week:1,title:'Map version 2',description:'Now includes storage.',reflection:'Storage keeps things after shutdown.',fileId})).status,201);
  assert.equal((await parent.call('/api/review',{...review,status:'approved',feedback:'Well explained!'})).status,200);
  const s=(await parent.call('/api/academy')).body;
  assert.equal(s.children[0].unlocked,2); assert.equal(s.projects.length,2); assert.deepEqual(s.projects.map(p=>p.version).sort(),[1,2]);
  assert.equal((await student.call('/api/progress',{action:'step',week:2,stepId:'a0',completed:true})).status,200);
});
test('family export contains attachments but never credentials or session tokens',async()=>{
  const res=await parent.call('/api/export'); assert.equal(res.status,200);
  assert.equal(res.body.files[0].id,fileId); assert.ok(!('csrfToken' in res.body));
  assert.ok(!JSON.stringify(res.body).includes('password'));
});
test('data and signed-in sessions survive restarting the server',async()=>{
  await app.close(); await start();
  const res=await parent.call('/api/academy'); assert.equal(res.body.role,'parent');
  assert.equal(res.body.children[0].id,childId); assert.equal(res.body.projects.length,2);
  assert.equal((await parent.call('/api/files/'+fileId)).status,200);
});
test('parent passphrase reset revokes existing student sessions',async()=>{
  assert.equal((await parent.call('/api/child-settings',{childId,password:'a replacement student secret'})).status,200);
  assert.equal((await student.call('/api/academy')).body.role,'guest');
  assert.equal((await student.call('/api/child-login',{username:'little-explorer',password:'student secret phrase'})).status,401);
  assert.equal((await student.call('/api/child-login',{username:'little-explorer',password:'a replacement student secret'})).status,200);
});
test('logout revokes session and the database is never served publicly',async()=>{
  assert.equal((await student.call('/api/logout',{})).status,200);
  assert.equal((await student.call('/api/academy')).body.role,'guest');
  assert.equal((await guest.call('/data/academy.sqlite')).status,404);
  assert.equal((await guest.call('/server.mjs')).status,404);
});
test('a second student cannot read a sibling’s files or private progress',async()=>{
  const sibling=client();
  assert.equal((await parent.call('/api/children',{nickname:'Second explorer',username:'second-explorer',password:'another student passphrase'})).status,201);
  assert.equal((await sibling.call('/api/child-login',{username:'second-explorer',password:'another student passphrase'})).status,200);
  const s=(await sibling.call('/api/academy')).body;
  assert.equal(s.children.length,1); assert.equal(s.children[0].username,'second-explorer');
  assert.equal(s.projects.length,0); assert.equal(s.progress.length,0);
  assert.equal((await sibling.call('/api/files/'+fileId)).status,404);
});
test('oversized requests return a useful 413 response',async()=>{
  const res=await parent.call('/api/children',{nickname:'X'.repeat(100_000)});
  assert.equal(res.status,413); assert.match(res.body.error,/too large/);
});
