import {MultiremiStore} from '@multiremi/store.js';
import {PostgresSyncDatabase} from '@multiremi/store/db/postgres.js';
import {StoreContext,createCommitEventQueue} from '@multiremi/store/context.js';
import {reRingAfterTurnEnd} from '@multiremi/store/inbox/lane-machine.js';
import {existsSync} from 'node:fs';
const input=JSON.parse(await Bun.stdin.text()),db=new PostgresSyncDatabase(input.databaseUrl),store=new MultiremiStore(db);
console.log('ready');
const deadline=Date.now()+15_000;while(!existsSync(input.release)){if(Date.now()>deadline)throw new Error('Barrier timed out');await Bun.sleep(10);}
try{
  if(input.operation==='send')console.log(JSON.stringify(store.sendMessage(input.message)));
  else if(input.operation==='complete')console.log(JSON.stringify(store.getDaemonTurnBridge().complete(input.complete,input.scope)));
  else console.log(JSON.stringify(db.transaction(()=>{const ctx=new StoreContext(db,()=>store);ctx.lockWorkspaceRuntimeLifecycle('local');return reRingAfterTurnEnd(ctx,input.turnId,createCommitEventQueue());})()));
}finally{db.close();}
