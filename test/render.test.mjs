import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publicLessons, rubric } from '../curriculum.mjs';

// Pure view tests: no browser, external network, production accounts or fixture data shipped.
const source = readFileSync(new URL('../public/app.js', import.meta.url),'utf8');
function renderer(fixture,hash='') {
  const root={innerHTML:''};
  const context=vm.createContext({
    document:{querySelector:()=>root,addEventListener:()=>{}},
    location:{hash},addEventListener:()=>{},
    fetch:()=>new Promise(()=>{}),fixture,
    window:{scrollTo:()=>{}},setTimeout,clearTimeout,URL,
  });
  vm.runInContext(source,context);
  return (route,week=1)=>{
    context.nextRoute=route;context.nextWeek=week;
    vm.runInContext('state=fixture;readHash(); route=nextRoute; week=nextWeek; render()',context);
    return root.innerHTML;
  };
}
const child={id:'child-1',nickname:'Explorer',username:'student-one',unlocked:24,schedule:'Two sessions'};
const base={lessons:publicLessons,rubric,registrationOpen:true,children:[child],progress:[],projects:[],activity:[],user:{name:'Parent',nickname:'Explorer'},csrfToken:'test-token',ai:{configured:true,typedQuestionsAllowed:false,helpModes:[{id:'explain',label:'Explain this idea'}]},aiMessages:[],aiSettings:[{childId:child.id,enabled:1,mode:'guided',dailyLimit:20,used:1}],assignments:[]};
test('guest account choices render and all authenticated pages produce content',()=>{
  assert.match(renderer({...base,role:'guest'})('dashboard'),/Create a parent account/);
  for(const role of ['parent','child']) for(const route of ['dashboard','curriculum','projects',...(role==='parent'?['family']:[])]) {
    const html=renderer({...base,role})(route);
    assert.match(html,/<main id="main"/); assert.ok(!html.includes('undefined'));
  }
});
test('all 24 lessons render with complete sessions and correct role controls',()=>{
  for(const role of ['parent','child']) {
    const render=renderer({...base,role});
    for(let week=1;week<=24;week++) {
      const html=render('lesson',week);
      assert.ok(html.includes(publicLessons[week-1].title));
      assert.equal((html.match(/data-step=/g)||[]).length,6);
      assert.equal(html.includes('Parent teaching notes'),role==='parent');
      assert.equal(html.includes('id="project-form"'),role==='child');
    }
  }
});
test('user content is escaped in names, project fields and attachment labels',()=>{
  const attack='"><img src=x onerror=alert(1)>';
  const fixture={...base,role:'parent',user:{name:attack},children:[{...child,nickname:attack}],projects:[{id:'p',childId:child.id,week:1,title:attack,description:attack,reflection:attack,link:'https://example.test/',fileId:'f',filename:attack,version:1,createdAt:'2026-11-19'}]};
  for(const route of ['dashboard','family','projects','lesson']) {
    const html=renderer(fixture)(route);
    assert.ok(!html.includes('<img src=x')); assert.ok(html.includes('&lt;img'));
  }
});
test('tutor roster, parent support controls and admin management render by role',()=>{
  const teacher=renderer({...base,role:'tutor'});
  assert.match(teacher('dashboard'),/Your tutor workspace/);
  assert.ok(!teacher('lesson').includes('id="project-form"'));
  assert.ok(!teacher('dashboard').includes('href="#family"'));
  assert.match(renderer({...base,role:'parent'})('support'),/Grant tutor access/);
  assert.match(renderer({...base,role:'parent',isAdmin:true,admin:{familyCount:1,studentCount:1,tutors:[]}})('admin'),/Create tutor account/);
  assert.ok(!renderer({...base,role:'parent',isAdmin:false})('admin').includes('id="tutor-create-form"'));
});
test('AI guided mode offers no text entry; transcript text is safely escaped',()=>{
  const fixture={...base,role:'child',aiMessages:[{id:1,childId:child.id,week:1,role:'assistant',content:'<script>bad()</script>',flagged:0}]};
  const html=renderer(fixture)('ai');assert.match(html,/data-ai-mode="explain"/);assert.ok(!html.includes('id="ai-chat-form"'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  const chat=renderer({...fixture,ai:{...base.ai,typedQuestionsAllowed:true},aiSettings:[{...base.aiSettings[0],mode:'chat'}]})('ai');
  assert.match(chat,/id="ai-chat-form"/);
});

test('public landing and sign-in are separate views; content editing is restricted and escaped',()=>{
  const render=renderer({...base,role:'guest'});
  assert.match(render('home'),/Small steps. Brilliant discoveries/);
  assert.ok(!render('home').includes('id="auth-form"'));
  assert.match(render('login'),/id="auth-form"/);
  assert.ok(!renderer({...base,role:'parent',canEditContent:false})('content').includes('id="lesson-edit-form"'));
  assert.match(renderer({...base,role:'tutor',canEditContent:true})('content'),/Open content editor/);
  const attack='<img src=x onerror=alert(1)>';
  assert.ok(!renderer({...base,role:'guest',landing:{headline:attack}})('home').includes('<img src=x'));
});

test('administrator assignment form and current assignments are visible and escaped',()=>{
  const attack='<img src=x onerror=alert(1)>';
  const html=renderer({...base,role:'parent',isAdmin:true,admin:{parents:[],students:[{...child,parentName:'Family',active:1}],tutors:[{id:'t',name:attack,email:'t@example.test',active:1}],assignments:[{childId:child.id,tutorId:'t',studentName:child.nickname,tutorName:attack,active:1}],familyCount:1,studentCount:1}})('admin');
  assert.match(html,/id="admin-assignment-form"/);assert.match(html,/Assign student to tutor/);assert.match(html,/Remove assignment/);
  assert.ok(html.indexOf('Student assignments')<html.indexOf('Add a parent'));assert.ok(!html.includes('<img src=x'));
});
test('tutor can open each student dashboard and modules with editable lesson checkboxes',()=>{
  const second={...child,id:'child-2',nickname:'Second explorer'};
  const fixture={...base,role:'tutor',children:[child,second]};
  const roster=renderer(fixture)('dashboard');
  assert.equal((roster.match(/data-student-page="student"/g)||[]).length,2);
  assert.equal((roster.match(/data-student-page="curriculum"/g)||[]).length,2);
  const selected=renderer(fixture,'#student/child-2');
  assert.match(selected('student'),/Second explorer’s learning adventure/);
  assert.match(selected('curriculum'),/Second explorer’s learning path/);
  assert.match(selected('curriculum'),/href="#student\/child-2"/);
  const lesson=selected('lesson');
  assert.equal((lesson.match(/data-step="[ab][0-2]"[^>]* disabled/g)||[]).length,0);
  assert.ok(lesson.includes('<fieldset disabled>')); // Knowledge check remains student-only.
  const revoked=renderer({...fixture,children:[child]},'#student/child-2')('student');
  assert.match(revoked,/Student access unavailable/);assert.ok(!revoked.includes('learning adventure'));
});
