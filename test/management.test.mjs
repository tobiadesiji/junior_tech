import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAcademy} from '../server.mjs';
import {lessons} from '../curriculum.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('academy management, content persistence and parent saves',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'academy-management-'));
  const options={dbPath:join(dir,'academy.sqlite'),allowRegistration:true,adminEmail:'admin@example.test'};
  let app,base;
  async function start(){app=createAcademy(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;}
  function client(){const c={cookie:'',csrf:''};c.call=async(path,data,csrf=c.csrf)=>{
    const r=await fetch(base+path,{method:data?'POST':'GET',headers:{Origin:'http://localhost:3000',Cookie:c.cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:data?JSON.stringify(data):undefined});
    if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];
    const body=await r.json();if(body.csrfToken)c.csrf=body.csrfToken;return{status:r.status,body};
  };return c;}
  await start();
  try{
    const admin=client(),parent=client(),other=client(),student=client(),tutor=client(),guest=client();
    for(const [c,name] of [[admin,'admin'],[parent,'parent'],[other,'other']])assert.equal((await c.call('/api/register',{name,email:`${name}@example.test`,password:'a test account passphrase'})).status,201);
    const childId=(await parent.call('/api/children',{nickname:'Explorer',username:'explorer',password:'a student passphrase'})).body.childId;
    await student.call('/api/child-login',{username:'explorer',password:'a student passphrase'});
    await admin.call('/api/admin/tutors',{action:'create',name:'Teacher',email:'tutor@example.test',password:'a tutor passphrase'});
    await tutor.call('/api/tutor-login',{email:'tutor@example.test',password:'a tutor passphrase'});
    await t.test('admin sees all account types, other roles cannot access directories or mutate accounts',async()=>{
      const state=(await admin.call('/api/academy')).body;
      assert.equal(state.admin.parents.length,3);assert.equal(state.admin.students[0].id,childId);assert.equal(state.admin.tutors.length,1);
      assert.ok(!JSON.stringify(state.admin).includes('password'));
      for(const c of [parent,other,student,tutor]){assert.equal((await c.call('/api/academy')).body.admin,undefined);assert.equal((await c.call('/api/admin/accounts',{role:'child',id:childId,action:'status',active:false})).status,403);}
      assert.equal((await guest.call('/api/admin/accounts',{role:'child',id:childId,action:'status',active:false})).status,401);
    });
    await t.test('parents can save learning steps and study settings with family ownership checks',async()=>{
      const payload={childId,week:1,action:'step',stepId:'a0',completed:true};
      assert.equal((await parent.call('/api/progress',payload)).status,200);
      assert.equal((await other.call('/api/progress',payload)).status,404);
      assert.equal((await parent.call('/api/progress',{...payload,action:'quiz',answer:1})).status,403);
      assert.deepEqual((await student.call('/api/academy')).body.progress[0].completedSteps,['a0']);
      assert.equal((await parent.call('/api/child-settings',{childId,nickname:'Explorer 2',schedule:'',unlocked:3})).status,200);
      assert.equal((await parent.call('/api/child-settings',{childId,nickname:'Explorer 2',schedule:'Saturday mornings',unlocked:2})).status,200);
      assert.equal((await parent.call('/api/ai/settings',{childId,enabled:true,mode:'guided',dailyLimit:7})).status,200);
    });
    await t.test('stale CSRF is distinguishable and still rejects the write',async()=>{
      const r=await parent.call('/api/child-settings',{childId,nickname:'Must not save',schedule:'',unlocked:2},'old-token');
      assert.equal(r.status,403);assert.equal(r.body.code,'STALE_CSRF');assert.equal((await parent.call('/api/academy')).body.children[0].nickname,'Explorer 2');
    });
    await t.test('tutors and admin edit content; other roles cannot; revisions prevent lost updates',async()=>{
      const content=(await tutor.call('/api/content?week=1')).body;
      const value={...content.lesson,title:'A lesson edited by a tutor',quiz:{...content.lesson.quiz,answer:0}};
      const data={kind:'lesson',week:1,revision:0,value};
      for(const c of [parent,student])assert.equal((await c.call('/api/content',data)).status,403);
      assert.equal((await tutor.call('/api/content',data)).status,200);
      assert.equal((await admin.call('/api/content',data)).status,409);
      assert.equal((await guest.call('/api/academy')).body.lessons[0].title,value.title);
      assert.ok(!('answer' in (await student.call('/api/academy')).body.lessons[0].quiz));
      assert.equal((await student.call('/api/progress',{action:'quiz',week:1,answer:0})).body.passed,true);
      assert.equal((await tutor.call('/api/content',{...data,revision:1,value:{...value,resources:[{title:'Unsafe',url:'javascript:alert(1)'}]}})).status,400);
      assert.equal((await tutor.call('/api/content',{...data,revision:1,value:{...value,sessionA:{...value.sessionA,steps:['Only one']}}})).status,400);
      assert.equal((await admin.call('/api/content',{kind:'landing',revision:0,value:{...content.landing,headline:'Learn, make, discover'}})).status,200);
    });
    await t.test('admin updates any student and parent, resets access and pauses active sessions',async()=>{
      assert.equal((await admin.call('/api/admin/accounts',{role:'child',id:childId,action:'update',nickname:'New nickname',username:'new-explorer',schedule:'Sunday',unlocked:4})).status,200);
      assert.equal((await admin.call('/api/admin/accounts',{role:'child',id:childId,action:'reset',password:'another student passphrase'})).status,200);
      assert.equal((await student.call('/api/academy')).body.role,'guest');
      await student.call('/api/child-login',{username:'new-explorer',password:'another student passphrase'});
      const id=(await parent.call('/api/academy')).body.user.id;
      assert.equal((await admin.call('/api/admin/accounts',{role:'parent',id,action:'status',active:false})).status,200);
      assert.equal((await parent.call('/api/academy')).body.role,'guest');assert.equal((await student.call('/api/academy')).body.role,'guest');
      assert.equal((await parent.call('/api/login',{email:'parent@example.test',password:'a test account passphrase'})).status,401);
      assert.equal((await admin.call('/api/admin/accounts',{role:'parent',id,action:'status',active:true})).status,200);
      await parent.call('/api/login',{email:'parent@example.test',password:'a test account passphrase'});
      assert.equal((await admin.call('/api/admin/accounts',{role:'parent',id,action:'update',name:'Updated Parent',email:'new-parent@example.test'})).status,200);
      assert.equal((await parent.call('/api/academy')).body.role,'guest');
      assert.equal((await parent.call('/api/login',{email:'new-parent@example.test',password:'a test account passphrase'})).status,200);
      const owner=(await admin.call('/api/academy')).body.user.id;
      assert.equal((await admin.call('/api/admin/accounts',{role:'parent',id:owner,action:'status',active:false})).status,400);
    });
    await t.test('administrator creates a student for another family with duplicate protection',async()=>{
      const id=(await parent.call('/api/academy')).body.user.id;
      const data={role:'child',action:'create',parentId:id,nickname:'Second explorer',username:'second-explorer',password:'a new student passphrase'};
      assert.equal((await admin.call('/api/admin/accounts',data)).status,200);
      assert.equal((await admin.call('/api/admin/accounts',data)).status,409);
      assert.equal((await parent.call('/api/academy')).body.children.length,2);
    });
    await t.test('edited lessons, landing copy and original data survive restart',async()=>{
      await app.close();await start();
      const content=(await guest.call('/api/academy')).body;
      assert.equal(content.landing.headline,'Learn, make, discover');assert.equal(content.lessons[0].title,'A lesson edited by a tutor');assert.equal(lessons[0].title,'Computer detective');
      assert.equal((await admin.call('/api/academy')).body.admin.students.find(s=>s.id===childId).nickname,'New nickname');
      assert.ok(app.db.prepare('SELECT count(*) AS n FROM admin_audit').get().n>=6);
    });
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
