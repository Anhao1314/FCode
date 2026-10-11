import {readFile} from 'node:fs/promises';
import {ResearchLoop} from '../loop.mjs';
import {POLICIES} from '../policies.mjs';
const config=JSON.parse(await readFile(process.argv[2]));
const loop=new ResearchLoop(config.root,config.bundle,{stepAfterPhase:async phase=>{if(phase==='action-started'){process.send({phase});await new Promise(()=>{});}}});
await loop.run(config.id,loop.context(),POLICIES.candidate);

