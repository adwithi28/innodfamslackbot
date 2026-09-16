const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('message handler persists five Julia snipes and only Julia/Christy on the coffee chat', async () => {
  let handler;
  const calls=[];
  const members=['JULIA','A','JES','JON','R','AD','C'].map(id=>({id:'m'+id,name:id,slack_user_id:'U'+id}));
  const tasks=[{id:'s',name:'Snipe',points:1},{id:'c',name:'Reach-out Coffee Chat',points:5}];
  const supabase={
    from(table) {
      const data=table==='members'?members:table==='tasks'?tasks:table==='semesters'?{id:'semester'}:null;
      const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data,error:null}),then:(ok,bad)=>Promise.resolve({data,error:null}).then(ok,bad)};
      return query;
    },
    storage:{from:()=>({upload:async()=>({error:null}),getPublicUrl:path=>({data:{publicUrl:'https://example.test/'+path}})})},
    rpc:async(name,args)=>{calls.push({name,args});return {data:'saved',error:null};}
  };
  const replies=[];
  const context={
    require:name=>name==='dotenv'?{config:()=>{}}:name==='@slack/bolt'?{App:class {event(name,fn){handler=fn;} async start(){}}}:name==='@supabase/supabase-js'?{createClient:()=>supabase}:require(name),
    process:{env:Object.fromEntries(['SLACK_BOT_TOKEN','SLACK_APP_TOKEN','SLACK_SIGNING_SECRET','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].map(k=>[k,'test']))},
    console:{log:()=>{},error:message=>{throw Error(message);}},Buffer,
    fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(0)})
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./app'),'utf8'),context);
  await handler({event:{user:'UJULIA',channel:'C1',ts:'100.1',text:'<@UA> <@UJES> <@UJON> <@UR> <@UAD> +reach out cc with <@UC>',files:[{id:'F1',mimetype:'image/jpeg',url_private:'https://example.test/file'}]},client:{reactions:{add:async()=>{}},chat:{postMessage:async message=>replies.push(message)}}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'save_slack_submission');
  const items=JSON.parse(JSON.stringify(calls[0].args.p_items));
  assert.equal(items.length,6);
  for(const item of items.slice(0,5)) {assert.deepEqual(item.member_ids,['mJULIA']);assert.equal(item.final_task_id,'s');}
  assert.deepEqual(items[5].member_ids,['mJULIA','mC']);
  assert.equal(items[5].final_task_id,'c');
  assert.match(replies[0].text,/6 activities/);
});
