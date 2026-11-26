import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAcademy} from '../server.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('administrator assignments and tutor student pathways',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'academy-tutors-'));
  const options={dbPath:join(dir,'test.sqlite'),origin:'http://localhost:3000',production:false,allowRegistration:true,adminEmail:'admin@example.test'};
  let app,base;
  async function start(){app=createAcademy(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;}
  function client(){const c={cookie:'',csrf:''};c.call=async(path,data,csrf=c.csrf)=>{
    const r=await fetch(base+path,{method:data?'POST':'GET',headers:{Origin:options.origin,Cookie:c.cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:data?JSON.stringify(data):undefined});
    if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];const body=await r.json();if(body.csrfToken)c.csrf=body.csrfToken;return{status:r.status,body};
  };return c;}
  await start();
  try{
    const admin=client(),parent=client(),other=client(),tutor=client(),otherTutor=client(),student=client(),guest=client();
    for(const[c,name]of[[admin,'admin'],[parent,'parent'],[other,'other']])await c.call('/api/register',{name,email:`${name}@example.test`,password:'synthetic parent passphrase'});
    const childId=(await parent.call('/api/children',{nickname:'First explorer',username:'first-explorer',password:'synthetic child passphrase'})).body.childId;
    const secondId=(await other.call('/api/children',{nickname:'Second explorer',username:'second-explorer',password:'synthetic child passphrase'})).body.childId;
    const thirdId=(await other.call('/api/children',{nickname:'Third explorer',username:'third-explorer',password:'synthetic child passphrase'})).body.childId;
    for(const name of ['tutor','other-tutor'])await admin.call('/api/admin/tutors',{action:'create',name,email:`${name}@example.test`,password:'synthetic tutor passphrase'});
    const tutors=(await admin.call('/api/academy')).body.admin.tutors,tutorId=tutors.find(t=>t.name==='tutor').id,otherTutorId=tutors.find(t=>t.name==='other-tutor').id;
    await tutor.call('/api/tutor-login',{email:'tutor@example.test',password:'synthetic tutor passphrase'});
    await otherTutor.call('/api/tutor-login',{email:'other-tutor@example.test',password:'synthetic tutor passphrase'});
    await student.call('/api/child-login',{username:'first-explorer',password:'synthetic child passphrase'});
    const assignment={action:'assign',childId,tutorId};
    await t.test('only administrator can assign any student, with CSRF and validation',async()=>{
      for(const c of[parent,other,tutor,otherTutor,student])assert.equal((await c.call('/api/admin/assignments',assignment)).status,403);
      assert.equal((await guest.call('/api/admin/assignments',assignment)).status,401);
      assert.equal((await admin.call('/api/admin/assignments',assignment,'stale')).status,403);
      assert.equal((await admin.call('/api/admin/assignments',{...assignment,childId:'missing'})).status,404);
      assert.equal((await admin.call('/api/admin/assignments',{...assignment,tutorId:'missing'})).status,404);
      assert.equal((await admin.call('/api/admin/assignments',assignment)).status,200);
      assert.equal((await admin.call('/api/admin/assignments',assignment)).status,200);
      assert.equal((await admin.call('/api/academy')).body.admin.assignments.length,1);
      assert.equal((await parent.call('/api/academy')).body.assignments[0].tutorId,tutorId);
      assert.equal((await parent.call('/api/academy')).body.admin,undefined);
    });
    await t.test('a tutor sees assigned students across families and their separate learning records',async()=>{
      await admin.call('/api/admin/assignments',{...assignment,childId:secondId});
      await admin.call('/api/admin/assignments',{...assignment,childId:thirdId,tutorId:otherTutorId});
      const s=(await tutor.call('/api/academy')).body;
      assert.deepEqual(s.children.map(c=>c.id).sort(),[childId,secondId].sort());assert.equal(s.lessons.length,24);
      assert.equal((await otherTutor.call('/api/academy')).body.children[0].id,thirdId);
      assert.equal((await tutor.call('/api/progress',{childId:thirdId,week:1,action:'step',stepId:'a0',completed:true})).status,404);
    });
    await t.test('tutor records and undoes steps; quizzes, locked weeks and submitted work stay protected',async()=>{
      const data={childId,week:1,action:'step',stepId:'a0',completed:true};
      assert.equal((await tutor.call('/api/progress',data)).status,200);
      assert.equal((await tutor.call('/api/progress',{...data,childId:secondId,stepId:'b1'})).status,200);
      assert.equal((await student.call('/api/academy')).body.progress[0].completedSteps[0],'a0');
      assert.equal((await tutor.call('/api/progress',{...data,week:2})).status,400);
      assert.equal((await tutor.call('/api/progress',{...data,action:'quiz',answer:1})).status,403);
      assert.equal((await tutor.call('/api/progress',{...data,completed:false})).status,200);
      assert.deepEqual((await student.call('/api/academy')).body.progress[0].completedSteps,[]);
      app.db.prepare("UPDATE progress SET status='submitted' WHERE child_id=? AND week=1").run(childId);
      assert.equal((await tutor.call('/api/progress',data)).status,409);
      app.db.prepare("UPDATE progress SET status='in_progress' WHERE child_id=? AND week=1").run(childId);
      assert.ok((await parent.call('/api/academy')).body.activity.some(a=>a.actor==='tutor'&&a.text.includes('learning step')));
    });
    await t.test('paused student, family or tutor cannot be assigned or accessed by tutors',async()=>{
      for(const [role,id]of[['child',secondId],['parent',(await other.call('/api/academy')).body.user.id]]){
        await admin.call('/api/admin/accounts',{role,id,action:'status',active:false});
        assert.equal((await admin.call('/api/admin/assignments',{...assignment,childId:secondId})).status,400);
        assert.ok(!(await tutor.call('/api/academy')).body.children.some(c=>c.id===secondId));
        assert.equal((await tutor.call('/api/progress',{childId:secondId,week:1,action:'step',stepId:'b0',completed:true})).status,404);
        await admin.call('/api/admin/accounts',{role,id,action:'status',active:true});
      }
      await admin.call('/api/admin/accounts',{role:'tutor',id:otherTutorId,action:'status',active:false});
      assert.equal((await admin.call('/api/admin/assignments',{...assignment,tutorId:otherTutorId})).status,400);
      assert.equal((await otherTutor.call('/api/academy')).body.role,'guest');
    });
    await t.test('assignments persist across restart; revocation immediately blocks stale tutor writes',async()=>{
      await app.close();await start();
      assert.equal((await tutor.call('/api/academy')).body.children.length,2);
      assert.equal((await admin.call('/api/admin/assignments',{...assignment,action:'revoke'})).status,200);
      assert.equal((await tutor.call('/api/progress',{childId,week:1,action:'step',stepId:'a1',completed:true})).status,404);
      assert.equal((await tutor.call(`/api/ai/history?childId=${childId}&week=1`)).status,404);
      assert.equal((await tutor.call('/api/academy')).body.children.length,1);
      assert.ok(app.db.prepare("SELECT count(*) AS n FROM admin_audit WHERE action='tutor assign'").get().n>=3);
      // Parent control remains available for an assignment made by the administrator.
      assert.equal((await other.call('/api/login',{email:'other@example.test',password:'synthetic parent passphrase'})).status,200);
      assert.equal((await other.call('/api/tutor-assignment',{action:'revoke',childId:secondId,tutorId})).status,200);
      assert.equal((await tutor.call('/api/academy')).body.children.length,0);
    });
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
