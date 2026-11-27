
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const html=readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
let count=0;
function check(name,fn){fn();count++;console.log('PASS '+name)}
function part(a,b){const start=html.indexOf(a);assert.ok(start>=0,a);const end=html.indexOf(b,start+a.length);assert.ok(end>start,b);return html.slice(start,end)}
function method(name){return part('    window.'+name+' =','\n    };')+'\n    };'}
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const base={console,document:{getElementById:()=>null},currentUser:{role:'user'}};
const kb=vm.createContext({...base});
vm.runInContext(part('    function getAccessibleKnowledgeBase','    function extractCoreIntent'),kb);
check('approved knowledge only',()=>assert.equal(kb.getAccessibleKnowledgeBase(['已審核','草稿待審','已停用'].map(status=>({title:status,status}))).length,1));
const r=vm.createContext({...base,inquiryContext:{}});
vm.runInContext(part('    function actualGroundedIds','    function ansOrJoin'),r);
check('empty actual sources remain empty',()=>assert.equal(r.actualGroundedIds({grounded_sop_ids:[],matched_sop_id:'candidate'}).length,0));
check('NO_MATCH clears references',()=>assert.equal(r.actualGroundedIds({answer:'NO_MATCH',grounded_sop_ids:['A']}).length,0));
check('actual references deduplicate',()=>assert.equal(r.actualGroundedIds({grounded_sop_ids:['A','A']}).length,1));
check('latest response replaces stale references',()=>{r.rememberAnswerSources({grounded_sop_ids:['A']});r.rememberAnswerSources(null);assert.equal(r.inquiryContext.groundedSopIds.length,0)});
const g=vm.createContext({...base,resolveRowTenantId:r=>r.tenant_id,matchNotificationsToGroup:()=>[],computeAlertLevel:()=> 'P5'});
vm.runInContext(part('    function classifySageTopic','    function getSageRuleThresholds')+part('    function sageDayBucket','    async function callSageCorrelateGateway'),g);
const t=(d,site='A')=>({tenant_id:'TEST',company_plant:'TEST ('+site+')',service_id:d+site,problem_description:'網路無法連線',created_at:d+'T10:00:00+08:00'});
const c=(d,site='A')=>({tenant_id:'TEST',company:'TEST',jurisdiction:site,session_id:d+site,message_role:'user',message_content:'網路無法連線',created_at:d+'T10:00:00+08:00'});
check('cross-day tickets separated',()=>assert.equal(g.buildRuleCandidateGroups([t('2026-11-01'),t('2026-11-27')],[],[]).length,2));
check('cross-site tickets and chats separated',()=>assert.equal(g.buildRuleCandidateGroups([t('2026-11-27')],[c('2026-11-27','B')],[]).length,2));
check('cross-day chat preserves prior ticket',()=>{const rows=g.buildRuleCandidateGroups([t('2026-11-26')],[c('2026-11-27')],[]);assert.equal(rows.length,2);assert.equal(rows.reduce((n,x)=>n+x.tickets.length,0),1)});
check('same-day same-site correlation preserved',()=>{const rows=g.buildRuleCandidateGroups([t('2026-11-27')],[c('2026-11-27')],[]);assert.equal(rows.length,1);assert.equal(rows[0].chats.length,1)});
check('UTC and Taipei normalize to same day',()=>assert.equal(g.sageDayBucket('2026-11-26T18:00:00Z','a'),g.sageDayBucket('2026-11-27T02:00:00+08:00','b')));
check('unknown dates do not share a guessed today bucket',()=>assert.notEqual(g.sageDayBucket(null,'a'),g.sageDayBucket(null,'b')));
async function audit(name,args,error){
 const alerts=[];let writes=0,refresh=0;
 const ctx=vm.createContext({...base,sageDataError:'',window:{fetchSageIncidentsFromSupabase:async()=>refresh++,openSageAuditDetailModal:()=>{}},CSS:{escape:x=>x},sageConfirmedIds:new Set(),sageDismissedIds:new Set(),sageAlertOverrides:new Map(),sageAuditReasons:new Map(),sageMajorIncidentMap:new Map(),sageSelectedClient:'TEST',sageLastModelUsed:'rule-engine',sageGroups:[{id:'TEST',tenantId:'TEST',tickets:[],chats:[],state:'SUSPECT'}],alert:x=>alerts.push(x),supabaseClient:{from:()=>({upsert:async()=>{writes++;return {error}}})}});
 vm.runInContext(method(name),ctx);await ctx.window[name](...args);
 check(name+(error?' failure':' success'),()=>{assert.equal(writes,1);assert.equal(alerts.length,error?1:0);assert.equal(refresh,error?0:1);
 if(name==='confirmSageGroup')assert.equal(ctx.sageConfirmedIds.has('TEST'),!error);
 if(name==='dismissSageGroup')assert.equal(ctx.sageDismissedIds.has('TEST'),!error);
 if(name==='setGroupAlertLevel')assert.equal(ctx.sageAlertOverrides.has('TEST'),!error);
 if(name==='handleMajorIncidentDecision')assert.equal(ctx.sageMajorIncidentMap.has('TEST'),!error);
 });
}
(async()=>{
for(const [n,args] of [['confirmSageGroup',['TEST']],['dismissSageGroup',['TEST']],['setGroupAlertLevel',['TEST','P2']],['handleMajorIncidentDecision',['TEST','APPROVE']]]){
 await audit(n,args,null);await audit(n,args,{message:'synthetic write failure'});
}
for(const failedTable of ['profiles','tickets','chat_logs','sage_incidents','event_notifications']){
 let scans=0;const panel={textContent:''};
 const ctx=vm.createContext({...base,window:{runSageCorrelationScan:async()=>scans++},document:{getElementById:()=>panel},populateSageClientSelector:()=>{},sageNotifications:[],supabaseClient:{from:table=>{const q={select:()=>q,order:()=>q,limit:async()=>({data:[],error:table===failedTable?{message:'synthetic read failure'}:null})};return q;}}});
 vm.runInContext(part("    let sageDataError = '';",'    const SAGE_RULE_MATRIX_DEFAULTS'),ctx);
 await ctx.window.fetchSageIncidentsFromSupabase();
 check('read failure blocks analysis: '+failedTable,()=>{assert.equal(scans,0);assert.match(panel.textContent,/尚未完成分析/)});
}
console.log('TOTAL '+count+' passed; no live services called');
})().catch(e=>{console.error(e);process.exitCode=1});
