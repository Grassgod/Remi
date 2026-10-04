import { expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

it('runtime SQL never mutates retired conversation storage',()=>{
  const root=join(import.meta.dir,'../../packages/server/src');
  const migrationOnly=new Set(['migrations.ts','conversation-log-backfill.ts','unified-model-migration.ts']);
  function scan(dir:string):void {
    for(const file of readdirSync(dir,{withFileTypes:true})){
      const path=join(dir,file.name);if(file.isDirectory()){scan(path);continue;}
      if(!file.name.endsWith('.ts')||migrationOnly.has(file.name))continue;
      const source=readFileSync(path,'utf8');
      expect(source.match(/\b(?:INSERT\s+(?:OR\s+IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+multiremi_(?:session_events|issue_comments|chat_messages)\b/gi)??[],path).toEqual([]);
    }
  }scan(root);
});
